import { pushStash } from "../magazine.ts";
import { MagazineStorage, type MagazineSessionIdentity } from "../storage.ts";

const [databasePath, sessionId, cwd, sessionFile, prefix, rawCount, mode = "normal"] = process.argv.slice(2);
if (!databasePath || !sessionId || !cwd || !sessionFile || !prefix || !rawCount) {
  throw new Error("storage-worker requires databasePath, sessionId, cwd, sessionFile, prefix, and count");
}
const count = Number.parseInt(rawCount, 10);
if (!Number.isInteger(count) || count < 1) throw new Error(`invalid count: ${rawCount}`);

const identity: MagazineSessionIdentity = { sessionId, cwd, sessionFile };
const storage = new MagazineStorage(databasePath);
storage.loadOrCreate(identity);
for (let i = 0; i < count; i++) {
  storage.mutate(identity, (current) => {
    const result = pushStash(current, `${prefix}-${i}`);
    return { state: result.state, value: undefined, changed: true };
  });
}

if (mode === "exit-without-close") {
  process.exit(0);
}
storage.close();
