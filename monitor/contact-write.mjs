import { config, failure, MonitorError } from './core.mjs';
import { googleClient } from './google.mjs';

const PERSON_FIELDS = 'names,nicknames,emailAddresses,phoneNumbers,birthdays,organizations,addresses,biographies,metadata';
const RESOURCE_RE = /^people\/[A-Za-z0-9._:-]+$/;

function fail(code, details = {}) {
  throw new MonitorError(code, details);
}

function resource(value) {
  if (typeof value !== 'string' || !RESOURCE_RE.test(value)) fail('INVALID_CONTACT_RESOURCE');
  return value;
}

function personFields(person) {
  if (!person || typeof person !== 'object' || Array.isArray(person)) fail('INVALID_CONTACT_PAYLOAD');
  const copy = JSON.parse(JSON.stringify(person));
  delete copy.etag;
  delete copy.metadata;
  delete copy.resourceName;
  return copy;
}

function etag(person) {
  const value = person?.etag || person?.metadata?.sources?.find(source => source?.etag)?.etag;
  return typeof value === 'string' && value ? value : null;
}

function sameEtag(actual, expected) {
  return !expected || expected === etag(actual);
}

async function fetchPerson(get, resourceName) {
  const person = await get(`people/v1/${resourceName}`, { personFields: PERSON_FIELDS });
  if (!person || person.resourceName !== resourceName) fail('CONTACT_NOT_FOUND');
  return person;
}

async function updateContact(get, input) {
  const resourceName = resource(input.resource_name);
  const current = await fetchPerson(get, resourceName);
  if (!sameEtag(current, input.expected_etag)) fail('CONTACT_CHANGED');
  const body = { resourceName, etag: etag(current), ...personFields(input.person) };
  const fields = Array.isArray(input.update_fields) ? [...new Set(input.update_fields.filter(value => typeof value === 'string'))] : [];
  if (!fields.length) fail('NO_CONTACT_CHANGES');
  const updated = await get.request(`people/v1/${resourceName}:updateContact`, {
    method: 'PATCH',
    params: { updatePersonFields: fields.join(','), personFields: PERSON_FIELDS },
    body
  });
  return { person: updated, operation: 'update', resource_name: resourceName, etag: etag(updated) };
}

async function createContact(get, input) {
  const body = personFields(input.person);
  if (!Object.keys(body).length) fail('NO_CONTACT_FIELDS');
  const created = await get.request('people/v1/people:createContact', {
    method: 'POST', params: { personFields: PERSON_FIELDS }, body
  });
  return { person: created, operation: 'create', resource_name: created?.resourceName || null, etag: etag(created) };
}

async function deleteContact(get, input) {
  const resourceName = resource(input.resource_name);
  const current = await fetchPerson(get, resourceName);
  if (!sameEtag(current, input.expected_etag)) fail('CONTACT_CHANGED');
  await get.request(`people/v1/${resourceName}:deleteContact`, { method: 'DELETE' });
  return { operation: 'delete', resource_name: resourceName, deleted: true };
}

async function main() {
  let input;
  try { input = JSON.parse(await new Promise((resolve, reject) => {
    let text = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; if (text.length > 1000000) reject(new Error('oversize')); });
    process.stdin.on('end', () => resolve(text)); process.stdin.on('error', reject);
  })); } catch { fail('INVALID_CONTACT_REQUEST'); }
  const get = await googleClient(config());
  let result;
  if (input?.action === 'get') result = { person: await fetchPerson(get, resource(input.resource_name)), operation: 'get' };
  else if (input?.action === 'update') result = await updateContact(get, input);
  else if (input?.action === 'create') result = await createContact(get, input);
  else if (input?.action === 'delete') result = await deleteContact(get, input);
  else fail('INVALID_CONTACT_OPERATION');
  process.stdout.write(JSON.stringify(result));
}

main().catch(error => { console.error(failure(error).code || 'CONTACT_WRITE_FAILED'); process.exitCode = 1; });
