/**
 * Shown after a sign-in that no OS secret store took (SEC-13): Kai then keeps it in a private
 * `0600` file, and the person should know where it is, not only the CLI's users.
 */
export const SECRET_FILE_NOTE =
  "No system keychain was available, so the sign-in is kept in a private file under ~/.kai/credentials that only your user can read.";
