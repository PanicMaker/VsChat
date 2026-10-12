const { ChatDB, message } = require('./runtime.cjs');

(async () => {
  const [directory, prefix] = process.argv.slice(2);
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'qq');
  await db.init();
  for (let i = 0; i < 30; i++) {
    await db.insertMessage(message(`${prefix}-${i}`));
    await db.setMetadata(`${prefix}-last`, String(i));
  }
  // All workers race to insert the same transport event.
  await db.insertMessage(message('shared-message'));
  await db.close();
})().catch((err) => { console.error(err); process.exitCode = 1; });
