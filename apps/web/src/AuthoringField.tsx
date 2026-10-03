import { cloneElement, useId, type AriaAttributes, type ReactElement } from 'react';

export function textHint(value: string, language: 'RU' | 'EN', required = true, maxLength = 5000) {
  if (required && !value.trim()) return `Add ${language === 'RU' ? 'Russian' : 'English'} text.`;
  if (value.length > maxLength) return `Use at most ${maxLength} characters.`;
  return undefined;
}

export function AuthoringField({ label, error, children }: {
  label: string; error?: string; children: ReactElement<AriaAttributes>;
}) {
  const hintId = useId();
  return <div className="authoring-field">
    <label>{label}{cloneElement(children, { 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? hintId : undefined })}</label>
    {error && <span className="field-hint" id={hintId}>{error}</span>}
  </div>;
}
