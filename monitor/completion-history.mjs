import {mkdir,writeFile,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

// The local smart-home service consumes this atomic handoff into the private
// nine-day completion journal. Monitoring does not depend on journal delivery.
export async function recordCompletedJob(job,source,count,durationMs,{directory=process.env.LAYNE_COMPLETION_OUTBOX}={}) {
  if(process.env.NODE_TEST_CONTEXT&&!directory)return false;
  directory ||= new URL('../logs/completion-outbox/',import.meta.url);
  const eventId=`background-job:${job.id}:completed`;
  const provider=String(source.kind||'provider').replaceAll('_',' ');
  const entry={event_id:eventId,completed_at:new Date().toISOString(),reason:'automated',source:'monitor_worker',
    title:`${provider} refresh completed`,first:`Layne refreshed ${provider} data`,
    second:Number.isFinite(Number(count))?`${Number(count)} records were processed successfully`:'The scheduled job finished and saved its current results',
    details:{description:`The scheduled ${provider} collection completed successfully.`,provider:source.kind,
      records_processed:count,duration_ms:durationMs,job_id:job.id,attempt:job.attempts}};
  const name='completion-'+createHash('sha256').update(eventId).digest('hex')+'.json';
  try{
    await mkdir(directory,{recursive:true});const base=directory instanceof URL?directory:pathToFileURL(resolve(directory)+sep);
    const temp=new URL('.'+name+'.'+randomUUID()+'.tmp',base),file=new URL(name,base);
    await writeFile(temp,JSON.stringify(entry),{encoding:'utf8',flag:'wx'});await rename(temp,file);return true;
  }catch{return false;}
}
