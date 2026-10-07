// Directus endpoint: d1-next-number  (mounted at /d1-next-number)
//
// GET /d1-next-number/sample[?exclude=<sample_id>]  ->  { next: 37 }
//
// The preview number shown by the Register sample page and the sample-code interface. It used to be
// computed in the browser from every sample_code the user could read, which is O(n) and undercounts
// when permissions hide rows. This asks Postgres (next_sample_code_number(), the same rule as the
// trigger that assigns the number on save), so it counts every sample. It reveals only that one
// number, and only to signed-in users with app access. The database still decides at save time.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
    id: 'd1-next-number',
    handler: (router, { database, logger }) => {
        router.get('/sample', async (req, res) => {
            const acc = req.accountability;
            if (!acc?.user) {
                return res.status(401).json({ error: 'authentication required' });
            }
            if (!(acc.admin || acc.app)) {
                return res.status(403).json({ error: 'forbidden' });
            }
            // ?exclude=a&exclude=b arrives as an array: reject it rather than ignore it.
            const raw = req.query.exclude;
            if (raw !== undefined && typeof raw !== 'string') {
                return res.status(400).json({ error: 'exclude must be a single sample_id (uuid)' });
            }
            const exclude = raw ?? null;
            if (exclude !== null && !UUID.test(exclude)) {
                return res.status(400).json({ error: 'exclude must be a sample_id (uuid)' });
            }
            try {
                const out = await database.raw('SELECT next_sample_code_number(?::uuid) AS next', [exclude]);
                const next = Number(out?.rows?.[0]?.next);
                if (!Number.isFinite(next)) throw new Error('no number returned');
                return res.json({ next });
            } catch (e) {
                logger.error(`d1-next-number: ${e?.message || e}`);
                return res.status(500).json({ error: 'could not read the next sample number' });
            }
        });
    },
};
