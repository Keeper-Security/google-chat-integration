/**
 * Form input helpers for approval card actions.
 */

export function collectCreateFormValues(event) {
  return {
    record_title: extractFormValue(event, 'record_title') || '',
    record_login: extractFormValue(event, 'record_login') || '',
    record_password: extractFormValue(event, 'record_password') || '',
    record_url: extractFormValue(event, 'record_url') || '',
    record_notes: extractFormValue(event, 'record_notes') || '',
    auto_gen: extractFormValues(event, 'auto_gen_password').includes('auto_gen'),
    link_expiration: extractFormValue(event, 'link_expiration') || '5m',
  };
}

export function extractFormValue(event, fieldName) {
  const values = extractFormValues(event, fieldName);
  return values.length ? values[0] : null;
}

export function extractFormValues(event, fieldName) {
  const formInputs = event.common?.formInputs || {};
  const field = formInputs[fieldName] || {};
  return field.stringInputs?.value || [];
}
