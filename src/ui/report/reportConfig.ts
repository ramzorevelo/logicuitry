// Where a bug report goes. One place to change.
//
// TWO forms, and the split is forced rather than chosen. A Google Form that
// has a file-upload question makes every respondent sign in, for the whole
// form, with no setting to turn that off. So the ordinary report goes to a
// text-only form the app posts to anonymously, and the screenshot route opens
// a second form that carries the upload question and asks for the sign-in it
// needs. Posting the usual report to the upload form would fail, and a no-cors
// POST cannot see that it failed.
//
// OWNER SETUP (I cannot do this part):
//   1. Both forms need the same eight questions, all "short answer" except
//      Description and Board, which should be "paragraph". The screenshot form
//      adds a ninth, "Screenshot (optional)", of type File upload.
//   2. Publish both. An unpublished form accepts nothing, and the POST cannot
//      tell. Set the text form's responder access to anyone with the link.
//   3. For each form: menu > pre-fill form, type 1..8 into the eight fields in
//      the order below, and read the entry ids out of the generated link. Make
//      the text form by copying the screenshot one and deleting the upload
//      question, which keeps the ids in step.
//   4. The POST url is the /viewform url with `viewform` replaced by
//      `formResponse`. The prefill url keeps `viewform`.
//
// Until FORM_URL is filled in, the dialog offers Copy report instead of a send
// button: it must never claim to have sent a report into a void. An
// unpublished form is the same void with none of the warning, so both forms
// have to stay published.

export const FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSchqxb5jVj5kUaUFtmCufyn51QbkhIB9ZRkE_wZjZeDG56sLg/formResponse';

/** Both forms carry these same ids: the text form is a copy of the screenshot
 *  one, and Google preserves a question's id through a copy. Deleting and
 *  re-adding a question on either form would mint a new id and split them, so
 *  re-read both prefill links if a question is ever rebuilt rather than edited. */
export const FORM_FIELDS = {
  description: 'entry.765716880',
  workbench: 'entry.187043051',
  version: 'entry.2011165521',
  build: 'entry.1984173027',
  browser: 'entry.1886284064',
  screen: 'entry.1143976140',
  lastError: 'entry.1590096739',
  board: 'entry.1753866853',
} as const;

/** Opened in a browser tab, prefilled, never posted to: the sign-in the upload
 *  question forces is something only the reporter can do. */
export const SCREENSHOT_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSeTItWHdg2JwghCoHN4gxVVYsNOIs1hZqCJvpmkmUpDzf7sNA/viewform';

export const SCREENSHOT_FORM_FIELDS = FORM_FIELDS;

export function reportingConfigured(): boolean {
  return FORM_URL.length > 0;
}

export function screenshotFormConfigured(): boolean {
  return SCREENSHOT_FORM_URL.length > 0;
}
