function test_octree_out()
% Regression test for the octree_out + live_cache.bin combination the Diagnostics Workbench's
% diag handler (process_diag_row, scripts/force_orchestrator.py) needs from a SINGLE
% process_force call: the raw-spiral octree emit (cloud.bin) AND the dense live cache
% (live_cache.bin), together. octree_out used to `return` right after writing cloud.bin,
% which meant run_analysis never reached its own `summary = struct(...)` assignment when
% octree_out was set -- calling code that also expected live_cache.bin got neither the file
% nor a clean error, just MATLAB's own generic "unassignedOutputs" error and a status='error'
% summary.json with that unhelpful message, not the real cause.
%
% Run: matlab -batch "addpath('scripts/matlab'); test_octree_out"
% Errors (non-zero exit) on any failed assertion; prints PASS lines otherwise.

tmp = tempname; mkdir(tmp);
matp = fullfile(tmp, '10-AA-TEST-1-1-F1.mat');
Fs = 25600; n = 60000;
t = (0:n-1)'/Fs;
rpm = 1500*ones(n,1);
% v1.0 layout: [t, 8 dyno cols, tacho]
dyno = repmat(50*sin(t*3), 1, 8) + 5*randn(n,8);
tacho = sign(sin(2*pi*(rpm(1)/60).*t));   % crude pulse train (base MATLAB; no toolbox)
DATA = [t, dyno, tacho]; %#ok<NASGU>
metadata = struct('fileVersion',1.0,'Rate',Fs,'Feed',0.1,'CutDiameter',60,'MaxRPM',1500); %#ok<NASGU>
save(matp, 'DATA', 'metadata', '-v7');

octp = fullfile(tmp, 'cloud.bin');
process_force(matp, tmp, struct('octree_out', octp, 'live_cache_points', 5000000));

% The regression: both artifacts must exist from this ONE call, and summary.json must report
% success, not the swallowed unassignedOutputs error.
assert(exist(octp, 'file') == 2, 'octree cloud.bin not written');
cachep = fullfile(tmp, 'live_cache.bin');
assert(exist(cachep, 'file') == 2, 'live_cache.bin not written alongside octree_out');

summp = fullfile(tmp, 'summary.json');
assert(exist(summp, 'file') == 2, 'summary.json not written');
summ = jsondecode(fileread(summp));
assert(strcmp(summ.status, 'done'), 'summary.json status=%s (expected done): %s', summ.status, summ.message);

% octree_out must still skip the FRM PNG rendering (that's what "skip_frm_png" means, and
% what the ORIGINAL early return was actually for) -- octree/diag callers never use them, and
% rendering three figures per file is wasted work at the scale the diag handler runs at.
assert(exist(fullfile(tmp, 'frm_Fx.png'), 'file') == 0, 'octree_out mode must skip FRM PNGs');

% cloud.bin (D1OC) and live_cache.bin (D1LC) cover the SAME cut window, but the cache is
% strided by write_live_cache's own decimation and the octree emit is not. They are therefore
% only equal in length when the window fits in live_cache_points (step == 1) -- which is the
% case here, and the case process_diag_row's index-aligned x/y pairing relies on directly.
octN   = read_bin_n(octp,   hex2dec('44314F43'), 1);   % D1OC: magic, N
cacheN = read_bin_n(cachep, hex2dec('44314C43'), 2);   % D1LC: magic, version, N
assert(octN == cacheN, ...
    'cloud.bin (%d pts) and live_cache.bin (%d pts) length mismatch at step=1', octN, cacheN);

fprintf('PASS octree_out + live_cache.bin (step=1): N=%d, status=%s\n', octN, summ.status);

% ---- step > 1: the decimated case the step=1 assertion above cannot reach ----------------
% The original version of this test only ever ran the block above, with live_cache_points at
% 5,000,000 against a 60,000-sample fixture -- so `step` was always 1 and `octN == cacheN` was
% vacuously true. That is why this file did not catch the real defect: for a cut window LARGER
% than live_cache_points, write_live_cache strides (step = ceil(N0/target)) while the octree
% emit does not, so the two files legitimately differ in length and process_diag_row must
% decimate the cloud to match rather than treat it as fatal.
%
% Forcing a small live_cache_points on the SAME fixture is what makes this cheap: no large
% synthetic is needed to exercise the strided path, only a target below the window length.
tmp2 = tempname; mkdir(tmp2);
octp2 = fullfile(tmp2, 'cloud.bin');
cachep2 = fullfile(tmp2, 'live_cache.bin');
target2 = 5000;
process_force(matp, tmp2, struct('octree_out', octp2, 'live_cache_points', target2));

octN2   = read_bin_n(octp2,   hex2dec('44314F43'), 1);
cacheN2 = read_bin_n(cachep2, hex2dec('44314C43'), 2);
assert(octN2 > target2, ...
    'fixture window (%d) must exceed target (%d) to exercise the strided path', octN2, target2);

% The contract process_diag_row's decimation depends on: the cache is exactly the cloud
% window sampled at 1:step:N0, so its length is fully determined by the cloud's.
step2 = max(1, ceil(octN2 / target2));
assert(step2 > 1, 'expected step > 1 for target=%d over a %d-point window', target2, octN2);
expectedN2 = numel(1:step2:octN2);
assert(cacheN2 == expectedN2, ...
    ['live_cache.bin length %d does not match the strided cloud: expected %d ' ...
     '(= numel(1:%d:%d)). process_diag_row derives its decimation from exactly this ' ...
     'relationship.'], cacheN2, expectedN2, step2, octN2);

% Matching LENGTHS is not enough. process_diag_row slices the cloud as x[::step] and pairs it
% with the cache POSITIONALLY, so an off-by-one in the stride's PHASE (x[1::step] rather than
% x[0::step]) would still produce the right count while silently pairing every point with the
% wrong sample -- garbage statistics presented as science, with no error raised anywhere. So
% assert the stride's actual VALUES, not just its length: the strided run's cache must be the
% unstrided run's cache sampled at 1:step:end, on the same fixture. Combined with the step=1
% block above (where cache and cloud are index-aligned one-to-one), this is what establishes
% that cloud(1:step:end) corresponds to the strided cache element for element.
tA = read_d1lc_t(cachep);       % step 1: index-aligned with cloud.bin, asserted above
tB = read_d1lc_t(cachep2);      % step 7
assert(numel(tA) == octN2, 'unstrided cache (%d) should match the cloud (%d)', numel(tA), octN2);
assert(isequal(tB, tA(1:step2:end)), ...
    ['strided live_cache.bin is not the unstrided cache sampled at 1:%d:end -- ' ...
     'write_live_cache''s stride phase/formula has changed, and process_diag_row''s ' ...
     'x[::step] pairing is no longer valid.'], step2);

fprintf('PASS octree_out + live_cache.bin (step=%d): cloud=%d, cache=%d, stride phase verified\n', ...
    step2, octN2, cacheN2);

% ---- build manifest + official crop window (MATLAB is not in CI: run by hand) ----------
% octree_out writes <octree_out>.json with the geometry used; crop_start_sec/crop_end_sec
% (seconds on the file's Time axis) replace the auto window and are reported in the JSON.
bj = jsondecode(fileread([octp '.json']));
assert(strcmp(bj.crop_source, 'auto'), 'no crop opts -> crop_source auto, got %s', bj.crop_source);
assert(strcmp(bj.speed_mode, 'measured'), 'speed_mode must be measured');
assert(bj.feed == 0.1 && bj.diam == 60 && bj.inner_diam == 0 && bj.ppr == 1, 'geometry mismatch');
assert(bj.cut_end_sec > bj.cut_start_sec, 'cut window must be non-empty');

tmp3 = tempname; mkdir(tmp3);
octp3 = fullfile(tmp3, 'cloud.bin');
cs = 0.5; ce = 1.5;
process_force(matp, tmp3, struct('octree_out', octp3, 'crop_start_sec', cs, 'crop_end_sec', ce));
b3 = jsondecode(fileread([octp3 '.json']));
assert(strcmp(b3.crop_source, 'override'), 'crop applied -> crop_source override');
% t is a sample grid at 1/Fs: start = first t >= cs, end = last t <= ce.
assert(abs(b3.cut_start_sec - cs) <= 1/Fs, 'cut_start_sec %g not at crop start %g', b3.cut_start_sec, cs);
assert(b3.cut_end_sec <= ce + eps && b3.cut_end_sec >= b3.cut_start_sec, ...
    'cut_end_sec %g beyond crop end %g', b3.cut_end_sec, ce);
n3 = read_bin_n(octp3, hex2dec('44314F43'), 1);
assert(n3 <= round((ce - cs) * Fs) + 2, 'octree has %d pts, more than the crop window', n3);
assert(read_bin_n(octp3, hex2dec('44314F43'), 1) < octN, 'crop must shorten the cloud');

% revs_cs is the cumulative raw revolutions at the window start, in the units of the live
% cache's `revs` array: for the auto run (cache step 1) it equals the cache's first revs value
% (float32), and the crop run's revs_cs is larger (it starts later).
revsA = read_d1lc_col(cachep, 6);
assert(abs(bj.revs_cs - double(revsA(1))) <= 1e-4 * max(1, abs(bj.revs_cs)), ...
    'revs_cs %g != live cache revs(1) %g', bj.revs_cs, revsA(1));
assert(b3.revs_cs > bj.revs_cs, 'crop starts later -> larger revs_cs');

% Crop is one unit: an unusable start rejects an otherwise valid end (and vice versa), and a
% crop that does not change the window stays crop_source auto.
tmp4b = tempname; mkdir(tmp4b);
octp4b = fullfile(tmp4b, 'cloud.bin');
process_force(matp, tmp4b, struct('octree_out', octp4b, 'crop_start_sec', 1e6, 'crop_end_sec', ce));
b4b = jsondecode(fileread([octp4b '.json']));
assert(strcmp(b4b.crop_source, 'auto'), 'bad start + valid end must reject the whole crop');
assert(read_bin_n(octp4b, hex2dec('44314F43'), 1) == octN, 'rejected crop must equal the auto cloud');
tmp4c = tempname; mkdir(tmp4c);
octp4c = fullfile(tmp4c, 'cloud.bin');
process_force(matp, tmp4c, struct('octree_out', octp4c, 'crop_start_sec', bj.cut_start_sec, ...
    'crop_end_sec', bj.cut_end_sec));
b4c = jsondecode(fileread([octp4c '.json']));
assert(strcmp(b4c.crop_source, 'auto'), 'a crop equal to the auto window must stay auto');

% Degenerate window (start past the end of the file): falls back to auto, never empty.
tmp4 = tempname; mkdir(tmp4);
octp4 = fullfile(tmp4, 'cloud.bin');
process_force(matp, tmp4, struct('octree_out', octp4, 'crop_start_sec', 1e6, 'crop_end_sec', 1e6 + 1));
b4 = jsondecode(fileread([octp4 '.json']));
assert(strcmp(b4.crop_source, 'auto'), 'degenerate crop must fall back to auto');
assert(read_bin_n(octp4, hex2dec('44314F43'), 1) == octN, 'degenerate crop must equal the auto cloud');

% grid_out writes the same manifest.
tmp5 = tempname; mkdir(tmp5);
grdp = fullfile(tmp5, 'grid.bin');
process_force(matp, tmp5, struct('grid_out', grdp, 'crop_start_sec', cs, 'crop_end_sec', ce, ...
    'grid', struct('n', 128)));
b5 = jsondecode(fileread([grdp '.json']));
assert(strcmp(b5.crop_source, 'override') && abs(b5.cut_start_sec - cs) <= 1/Fs, 'grid manifest mismatch');
fprintf('PASS build manifest + crop window (octree %d pts -> %d, grid manifest ok)\n', octN, n3);
fprintf('ALL OCTREE_OUT TESTS PASSED\n');
end

function t = read_d1lc_t(path)
%READ_D1LC_T  The `t` column out of a live_cache.bin. 32-byte header (magic, version, N as
% uint32; Fs, feed, diam, cs_sec, ce_sec as float32) then six float32[N] arrays, t first.
fid = fopen(path, 'r', 'l');
assert(fid >= 0, 'cannot open %s', path);
c = onCleanup(@() fclose(fid));
hdr = fread(fid, 3, 'uint32');
assert(hdr(1) == hex2dec('44314C43'), 'bad D1LC magic in %s', path);
fread(fid, 5, 'single');                 % Fs, feed, diam, cs_sec, ce_sec
t = fread(fid, hdr(3), 'single');
end

function n = read_bin_n(path, magic, n_before)
%READ_BIN_N  Little-endian header reader: check the magic, then return the point count that
% sits `n_before` uint32 fields in (D1OC has N immediately after the magic; D1LC has a
% version field between them).
fid = fopen(path, 'r', 'l');
assert(fid >= 0, 'cannot open %s', path);
c = onCleanup(@() fclose(fid));
hdr = fread(fid, n_before + 1, 'uint32');
assert(hdr(1) == magic, 'bad magic %#x in %s (expected %#x)', hdr(1), path, magic);
n = hdr(end);
end

function v = read_d1lc_col(path, col)
%READ_D1LC_COL  Column `col` (1=t, 2=Fx, 3=Fy, 4=Fz, 5=rpm, 6=revs_cum) of a live_cache.bin.
fid = fopen(path, 'r', 'l');
assert(fid >= 0, 'cannot open %s', path);
c = onCleanup(@() fclose(fid));
hdr = fread(fid, 3, 'uint32');
assert(hdr(1) == hex2dec('44314C43'), 'bad D1LC magic in %s', path);
fread(fid, 5, 'single');
all = fread(fid, [hdr(3) 6], 'single');
v = all(:, col);
end
