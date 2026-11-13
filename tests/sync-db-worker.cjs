const { ChatDB, message } = require('./runtime.cjs');

(async () => {
  const [directory, command, value, argument] = process.argv.slice(2);
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'qq');
  await db.init();
  const received = id => ({ ...message(id), direction: 'received', from_user_id: 'user', to_user_id: 'bot' });
  try {
    if (command === 'append') {
      for (let i = 0; i < Number(argument); i++) await db.insertMessage(received(`${value}-${i}`));
      await db.insertMessage(received('shared-event'));
    } else if (command === 'read') {
      await db.markRead(value, Number(argument));
    } else if (command === 'clear-and-append') {
      await db.clearAll();
      await db.insertMessage(received(value));
    } else {
      throw new Error(`Unknown worker command: ${command}`);
    }
  } finally {
    await db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
