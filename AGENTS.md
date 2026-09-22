# Flourish project instructions

## UI components

- Use shadcn components for every interactive UI control. Do not add raw feature-level `<button>`, `<input>`, `<select>`, `<textarea>`, checkbox, radio, dialog, popover, or calendar controls.
- Use the shared shadcn `DatePicker` and `MonthPicker` from `components/ui/date-picker.tsx`; never use native `input[type=date]` or `input[type=month]` controls.
- Add missing primitives through the shadcn CLI and keep reusable compositions under `components/ui`.
- Native HTML elements may exist only inside the implementation of a shadcn primitive, where they provide the underlying accessible semantics.
- Preserve the mobile-first layout and verify interactive changes at a 390 px viewport.
