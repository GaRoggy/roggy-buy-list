import { MonitorError } from './core.mjs';

const clip = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) || null : null;
const unique = values => [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].slice(0, 20);
export const PEOPLE_FIELDS = 'names,nicknames,emailAddresses,phoneNumbers,birthdays,organizations,addresses,biographies,metadata';

export function normalizePerson(person) {
  const resource = clip(person?.resourceName, 300);
  if (!resource) return null;
  const names = Array.isArray(person.names) ? person.names : [];
  const primary = names.find(item => item.metadata?.primary) || names[0] || {};
  const displayName = clip(primary.displayName || [primary.givenName, primary.familyName].filter(Boolean).join(' '), 240);
  const aliases = unique([
    ...names.map(item => clip(item.displayName, 160)),
    ...(person.nicknames || []).map(item => clip(item.value, 160))
  ].filter(name => name && name !== displayName));
  const emails = unique((person.emailAddresses || []).map(item => String(item.value || '').trim().toLowerCase()).filter(value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)));
  const phones = unique((person.phoneNumbers || []).map(item => clip(item.value, 64)));
  const organization = person.organizations?.find(item => item.metadata?.primary) || person.organizations?.[0] || {};
  return {
    kind: 'google_person', external_id: resource, occurred_at: null, status: 'processed',
    payload: { resource_name: resource, canonical_name: displayName || resource, aliases,
      emails, phones, organization: clip(organization.name, 240), job_title: clip(organization.title, 200),
      birthdays: (person.birthdays || []).slice(0, 5).map(item => item.date || {}).filter(item => item.month || item.day || item.year),
      addresses: (person.addresses || []).slice(0, 5).map(item => ({
        formatted: clip(item.formattedValue, 500), street: clip(item.streetAddress, 240), city: clip(item.city, 120),
        region: clip(item.region, 120), postal_code: clip(item.postalCode, 32), country_code: clip(item.countryCode, 8)
      })),
      notes: unique((person.biographies || []).map(item => clip(item.value, 1000))),
      user_defined: [], metadata: { source: 'google_people' } }
  };
}

export async function syncGooglePeople(_source, get) {
  const records = [], seen = new Set(); let pageToken;
  for (let page = 0; page < 100; page++) {
    // Keep the normalized monitor projection compact. Full addresses,
    // birthdays, biographies, and other editable fields are fetched only for
    // an on-demand, explicitly prepared contact mutation.
    const data = await get('people/v1/people/me/connections', {
      personFields: 'names,nicknames,emailAddresses,phoneNumbers,organizations,metadata', pageSize: '1000',
      ...(pageToken ? { pageToken } : {})
    });
    for (const person of data.connections || []) {
      const record = normalizePerson(person);
      if (record && !seen.has(record.external_id)) { seen.add(record.external_id); records.push(record); }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  if (pageToken) throw new MonitorError('PAGINATION_LIMIT');
  return { records, cursor: { synced_at: new Date().toISOString(), people_count: records.length } };
}
