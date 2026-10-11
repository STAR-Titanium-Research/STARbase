-- migrate:up
-- Audit the three tables the identity cleanup added: login_aliases (20261001000120) and the
-- additional-operators junctions (20261001000122). They were written in parallel with
-- 20261003000121_audit_all_business_tables, which attaches audit_<table> from an explicit list,
-- so the merge left them without one. Who ran an operation or test, and which login stands for
-- whom, are business data (ADR-0003); all three have a primary key, so record_id is real.

DROP TRIGGER IF EXISTS audit_login_aliases ON login_aliases;
CREATE TRIGGER audit_login_aliases
    AFTER INSERT OR UPDATE OR DELETE ON login_aliases
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

DROP TRIGGER IF EXISTS audit_operation_additional_operators ON operation_additional_operators;
CREATE TRIGGER audit_operation_additional_operators
    AFTER INSERT OR UPDATE OR DELETE ON operation_additional_operators
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

DROP TRIGGER IF EXISTS audit_session_additional_operators ON session_additional_operators;
CREATE TRIGGER audit_session_additional_operators
    AFTER INSERT OR UPDATE OR DELETE ON session_additional_operators
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- migrate:down
DROP TRIGGER IF EXISTS audit_session_additional_operators ON session_additional_operators;
DROP TRIGGER IF EXISTS audit_operation_additional_operators ON operation_additional_operators;
DROP TRIGGER IF EXISTS audit_login_aliases ON login_aliases;
