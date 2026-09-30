/** Fixed synthetic lifecycle worker; no filesystem, queue, network or model. */
const mode = process.argv[2];
const finish = () => {
  process.stdout.write('{"ok":true,"outcome":"resumed"}\n', () => {
    if (process.connected) process.disconnect();
  });
};
if (mode === 'exit-before-ready') process.exit(71);
else if (mode === 'disconnect-before-ready') { process.disconnect(); setInterval(() => {}, 1000); }
else if (mode === 'bad-ready') { process.send({ready: true, secret: 'PRIVATE'}); setInterval(() => {}, 1000); }
else {
  process.once('message', () => {
    if (mode === 'control') {
      process.once('message', finish); process.send({staged: true});
    } else if (mode === 'hang-after-start') setInterval(() => {}, 1000);
    else if (mode === 'overflow') process.stdout.write('PRIVATE'.repeat(2000), () => process.disconnect());
    else if (mode === 'stderr') process.stderr.write('PRIVATE', finish);
    else finish();
  });
  process.send({ready: true});
}
