# shellcheck shell=bash
# The schema-test harness, sourced once by tests/phase1_schema.sh before the section files in
# tests/schema/. A section file is a plain sequence of checks against $PSQL; it does not set
# options, cd, or print the results line, and it must not `exit`. Everything a section needs
# from the harness is here:
#
#   ok / bad                   count a PASS / FAIL and print it
#   run LABEL SQL              PASS when the SQL returns a non-empty result
#   run_eq LABEL SQL EXPECTED  PASS when the SQL returns exactly EXPECTED
#   expect_line VAR RE LABEL   PASS when a whole line of $VAR matches the regex RE  (grep -x)
#   expect_fixed VAR STR LABEL PASS when a whole line of $VAR is exactly STR        (grep -xF)
#   expect_match VAR RE LABEL  PASS when RE matches anywhere in $VAR               (grep)
#   migration NAME             the path of db/migrations/<stamp>_NAME.sql, or empty when absent;
#                              sections name a migration by its name, never its number, so
#                              renumbering one does not touch the tests
#   migration_up FILE          the text between -- migrate:up and -- migrate:down
#   migration_down FILE        the text after -- migrate:down
#
# The expect_* trio takes the NAME of the variable that holds a psql output (not its value), so
# a failure can print what psql actually said.

: "${DATABASE_URL:?DATABASE_URL must be set (e.g. postgres://d1:pw@localhost:5432/d1_db)}"
PSQL="psql $DATABASE_URL --no-psqlrc -t -A"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
run() {
    # run "label" "SQL"  — expects non-empty result from SQL
    local label="$1" sql="$2"
    local result
    result=$($PSQL -c "$sql" 2>&1) || { bad "$label (psql error: $result)"; return; }
    [[ -n "$result" ]] && ok "$label" || bad "$label (empty result)"
}
run_eq() {
    # run_eq "label" "SQL" "expected"
    local label="$1" sql="$2" expected="$3"
    local result
    result=$($PSQL -c "$sql" 2>&1) || { bad "$label (psql error: $result)"; return; }
    [[ "$result" == "$expected" ]] && ok "$label" || bad "$label (got '$result', want '$expected')"
}

# _expect GREP_FLAGS VAR PATTERN LABEL: the shared body of the expect_* trio. A failure shows the
# wanted pattern and the first 700 characters of the output (errors first, so they are not lost
# behind a long listing).
_expect() {
    local flags="$1" var="$2" pattern="$3" label="$4" out
    out="${!var}"
    if grep $flags -- "$pattern" <<<"$out"; then
        ok "$label"
    else
        bad "$label (wanted $pattern; psql output: $( { grep -m3 '^ERROR' <<<"$out"; printf '%s' "$out"; } | tr '\n' ' ' | cut -c1-700))"
    fi
}
expect_line()  { _expect -qx  "$@"; }
expect_fixed() { _expect -qxF "$@"; }
expect_match() { _expect -q   "$@"; }

migration() {
    # shellcheck disable=SC2012
    ls db/migrations/*_"$1".sql 2>/dev/null | head -1
}
migration_up()   { awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$1"; }
migration_down() { awk '/-- migrate:down/{f=1;next}f' "$1"; }
