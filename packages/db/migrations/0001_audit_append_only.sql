-- 감사 로그는 추가만 허용한다. 애플리케이션 버그나 잘못된 쿼리로 기록이 바뀌는 일을 막는다.
CREATE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events는 수정하거나 삭제할 수 없습니다.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
