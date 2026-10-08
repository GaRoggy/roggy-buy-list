-- Provider authentication/configuration failures must remain observable and
-- retryable. A failed job is bounded by its job-attempt limit, while the
-- source remains enabled so the scheduler can create a fresh job after the
-- source backoff. Only an explicit operator change may disable a source.
create or replace function public.monitor_fail(p_job uuid,p_token uuid,p_code text,p_delay integer,p_terminal boolean) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare j public.monitor_jobs; terminal boolean;
begin
 select * into j from public.monitor_jobs where id=p_job for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_token or j.lease_until<=now() then return false; end if;
 if p_code !~ '^[A-Z0-9_]{1,64}$' then p_code='UNKNOWN_ERROR'; end if;
 terminal=p_terminal or j.attempts>=5;
 update public.monitor_jobs set status=case when terminal then 'failed' else 'queued' end,
 run_at=now()+make_interval(secs=>greatest(1,least(coalesce(p_delay,3600),86400))),lease_until=null,
 completed_at=case when terminal then now() else null end,error_code=p_code where id=j.id;
 update public.monitor_runs set status='failed',completed_at=now(),error_code=p_code where job_id=j.id and attempt=j.attempts;
 -- Do not set enabled=false here. A terminal provider error (for example a
 -- rotated credential or a gateway outage) must not become a permanent,
 -- silent disable. The existing one-hour source backoff limits retries.
 update public.monitor_sources set error_code=p_code,next_run_at=now()+interval '1 hour' where id=j.source_id;
 return true;
end $$;

revoke all on function public.monitor_fail(uuid,uuid,text,integer,boolean) from public,anon,authenticated;
grant execute on function public.monitor_fail(uuid,uuid,text,integer,boolean) to service_role;
