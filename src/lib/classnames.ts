export function classNames(
  ...classes: Array<string | undefined | null | boolean | number>
) {
  return classes.filter(Boolean).join(" ");
}
