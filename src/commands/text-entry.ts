// Whether a key belongs to the user typing rather than to a shortcut.
//
// The UI base is React Aria Components, which is why this is more than a
// tagName check: React Aria's date and time segments are `contenteditable`
// `role="spinbutton"` divs, and a ComboBox's text half is a real input while a
// Select's trigger is a plain button. The rule is "does this widget consume
// characters" — a checkbox or a button doesn't, and `j` must still work there.

/** Input types that take no text; a shortcut should still fire from them. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/** Text-entry widgets that aren't `<input>` elements. */
const TEXT_ENTRY_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
])

const EDITABLE_HOST =
  '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]'

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false

  if (target.tagName === 'TEXTAREA') return true
  if (target.tagName === 'INPUT') {
    // `.type` normalises anything unrecognised to "text", so the deny-list is
    // the safe direction to state this in.
    return !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type)
  }

  const role = target.getAttribute('role')
  if (role !== null && TEXT_ENTRY_ROLES.has(role)) return true

  // `isContentEditable` is inherited by descendants in a browser but jsdom
  // doesn't implement it, so the attribute is walked as well.
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.closest(EDITABLE_HOST) !== null
}
