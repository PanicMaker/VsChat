const { ChatDB, message } = require('./runtime.cjs');

(async () => {
  const [directory] = process.argv.slice(2);
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'qq');
  await db.init();
  const results = [];
  for (const messageId of ['shared-a', 'shared-b']) {
    const inbound = await db.storeQqInbound({
      ...message(messageId), direction: 'received', from_user_id: 'user', to_user_id: 'bot',
    });
    const replies = await Promise.all(Array.from({ length: 4 }, () => db.reserveQqReply({
      appId: 'bot', openId: 'user', messageId, nowSeconds: 1_700_000_000,
      windowSeconds: 3600, maxReplies: 4,
    })));
    results.push({ messageId, inserted: inbound.inserted, replies });
  }
  await db.close();
  process.stdout.write(JSON.stringify(results));
})().catch((err) => { console.error(err); process.exitCode = 1; });
