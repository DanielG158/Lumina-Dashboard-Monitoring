/**
 * For actions that stop or restart something: the name has to be typed, so a slip of the mouse or a click on the wrong row
 * (the test server and the production server look alike) cannot take a machine down.
 */
export function confirmTyped(action: string, name: string): boolean {
  const typed = window.prompt(`${action}\n\nThis stops or restarts a running machine. Type its name to go ahead:\n${name}`);
  if (typed === null) return false;
  if (typed.trim().toLowerCase() === name.trim().toLowerCase()) return true;
  window.alert(`That does not match "${name}". Nothing was done.`);
  return false;
}
