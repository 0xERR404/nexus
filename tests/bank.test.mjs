import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {Ledger} from '../02-hub/modules/balance/store.mjs';
import {BankInbox,expenseProposal} from '../02-hub/modules/balance/bank.mjs';
import {createModule} from '../02-hub/modules/balance/index.mjs';
const now = Date.parse('2026-09-30T22:00:00Z');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'nexus-bank-')), file = path.join(dir,'ledger.sqlite');
  const ledger = new Ledger(file), bank = new BankInbox(ledger,{now:()=>now});
  t.after(() => {ledger.close();fs.rmSync(dir,{recursive:true,force:true});});
  const account = ledger.accounts()[0];
  const source = bank.create({name:'Телефон',package:'ru.example.bank',account:account.id,zone:'Europe/Moscow'});
  const header = 'Bearer '+source.token;
  const event = {eventId:'notification-1',package:'ru.example.bank',occurredAt:now,text:'Покупка 350,50 RUB. Магазин. Баланс 1000 RUB'};
  const transaction = {kind:'expense',account:account.id,category:ledger.snapshot().categories.find(c => c.kind === 'expense').id,date:'2026-10-01',amount:'350.50',note:'Магазин'};
  return {dir,file,ledger,bank,source,header,event,transaction};
}
test('bank expense parser distinguishes purchase from balance and ambiguous messages', () => {
  assert.deepEqual(expenseProposal('Карта *1234. Покупка 1\u00a0250,15 ₽. Баланс 5000 ₽'),{amount:125015,currency:'RUB'});
  assert.deepEqual(expenseProposal('Payment 10.25 USD'),{amount:1025,currency:'USD'});
  assert.deepEqual(expenseProposal('Списано 7,10 EUR'),{amount:710,currency:'EUR'});
  for (const text of ['Баланс 1250 RUB','Перевод 150 RUB','Возврат покупки 150 RUB','Оплата 150 RUB отменена','Оплата 2 RUB и покупка 3 RUB','Покупка 3.999 RUB','Покупка 0 RUB','Покупка 12345']) assert.equal(expenseProposal(text).amount,null,text);
  for (const text of ['Код: 123456. Оплата 5 RUB','Пароль 123456','Код подтверждения покупки','OTP 1234']) assert.equal(expenseProposal(text).ignored,true,text);
});
test('bank stores only token hashes and revocation stops existing token', t => {
  const f = fixture(t);
  assert.equal(JSON.stringify(f.bank.sources()).includes(f.source.token),false);
  assert.notEqual(f.ledger.db.prepare('SELECT token_hash FROM bank_sources').get().token_hash,f.source.token);
  assert.throws(() => f.bank.receive('',f.event),{status:401});
  assert.throws(() => f.bank.receive(f.header,{...f.event,package:'other.app'}),{status:403});
  f.bank.revoke(f.source.id);
  assert.throws(() => f.bank.receive(f.header,f.event),{status:401});
});
test('bank receives without changing balances, deduplicates retries and uses source timezone',t => {
  const f = fixture(t), first = f.bank.receive(f.header,f.event);
  assert.equal(first.state,'pending');
  assert.equal(f.bank.receive(f.header,f.event).id,first.id);
  assert.equal(f.bank.receive(f.header,{...f.event,eventId:'new-client-id'}).id,first.id);
  assert.equal(f.bank.list().total,1);
  assert.equal(f.bank.list().items[0].date,'2026-10-01');
  assert.equal(f.ledger.accounts()[0].balance,0);
  f.bank.receive(f.header,{...f.event,eventId:'next-purchase',occurredAt:now+1000});
  assert.equal(f.bank.list().total,2,'two real identical purchases at different times must survive');
});
test('bank accepts one expense exactly once, clears original text, and does not resurrect deleted transactions',t => {
  const f = fixture(t), event = f.bank.receive(f.header,f.event);
  const result = f.bank.resolve({id:event.id,action:'accept',transaction:f.transaction});
  assert.equal(result.state,'accepted');
  assert.equal(f.ledger.accounts()[0].balance,-35050);
  assert.deepEqual(f.bank.resolve({id:event.id,action:'accept',transaction:f.transaction}),result);
  assert.equal(f.bank.list().total,0);
  assert.equal(f.ledger.db.prepare('SELECT text FROM bank_events').get().text,'');
  f.ledger.db.prepare('DELETE FROM transactions WHERE id=?').run(result.transactionId);
  assert.equal(f.bank.receive(f.header,f.event).state,'accepted');
  f.bank.resolve({id:event.id,action:'accept',transaction:f.transaction});
  assert.equal(f.ledger.accounts()[0].balance,0);
});
test('bank atomic approval rolls back on invalid category, currency, archived account and failed database write',t => {
  const f = fixture(t), event = f.bank.receive(f.header,f.event);
  assert.throws(() => f.bank.resolve({id:event.id,action:'accept',transaction:{...f.transaction,category:'missing'}}),{status:404});
  assert.equal(f.bank.list().total,1);
  f.ledger.db.exec("CREATE TRIGGER bank_fail BEFORE UPDATE ON bank_events BEGIN SELECT RAISE(ABORT, 'test'); END;");
  assert.throws(() => f.bank.resolve({id:event.id,action:'accept',transaction:f.transaction}),/test/);
  assert.equal(f.ledger.accounts()[0].balance,0);
  assert.equal(f.bank.list().total,1);
  f.ledger.db.exec('DROP TRIGGER bank_fail;');
  f.ledger.db.prepare('UPDATE accounts SET currency=? WHERE id=?').run('USD',f.transaction.account);
  assert.throws(() => f.bank.resolve({id:event.id,action:'accept',transaction:f.transaction}),/Валюта/);
  f.ledger.db.prepare('UPDATE accounts SET currency=?,archived=1 WHERE id=?').run('RUB',f.transaction.account);
  assert.throws(() => f.bank.resolve({id:event.id,action:'accept',transaction:f.transaction}),/архив/);
  assert.equal(f.ledger.accounts()[0].balance,0);
});
test('bank rejects attempts to edit another transaction or create income through approval',t => {
  const f = fixture(t), event = f.bank.receive(f.header,f.event);
  for(const changes of [{id:'existing'},{kind:'income'},{kind:'transfer'}]) assert.throws(() => f.bank.resolve({id:event.id,action:'accept',transaction:{...f.transaction,...changes}}),{status:400});
  assert.equal(f.bank.list().total,1);
});
test('bank skips security messages without storing them and dismisses without changing balances',t => {
  const f = fixture(t);
  assert.equal(f.bank.receive(f.header,{...f.event,text:'Код подтверждения: 123456'}).state,'ignored');
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) n FROM bank_events').get().n,0);
  const event = f.bank.receive(f.header,f.event);
  assert.equal(f.bank.resolve({id:event.id,action:'dismiss'}).state,'dismissed');
  assert.equal(f.bank.receive(f.header,f.event).state,'dismissed');
  assert.equal(f.ledger.accounts()[0].balance,0);
});
test('bank validates dates, package IDs, time zones, payload size and bounds',t => {
  const f = fixture(t);
  for(const occurredAt of ['yesterday',now+3600000,now-91*86400000,null]) assert.throws(() => f.bank.receive(f.header,{...f.event,occurredAt}),{status:400});
  assert.throws(() => f.bank.receive(f.header,{...f.event,text:'x'.repeat(2001)}),{status:400});
  assert.throws(() => f.bank.create({name:'x',package:'*',account:f.transaction.account,zone:'UTC'}),{status:400});
  assert.throws(() => f.bank.create({name:'x',package:'ru.bank',account:f.transaction.account,zone:'wrong/zone'}),{status:400});
  assert.throws(() => f.bank.list(-1),{status:400});
});
test('bank hourly limit still acknowledges already received retries',t => {
  const f = fixture(t);
  for(let i=0;i<120;i++) f.bank.receive(f.header,{...f.event,eventId:String(i),occurredAt:now+i});
  assert.throws(() => f.bank.receive(f.header,{...f.event,eventId:'overflow',occurredAt:now+121}),{status:429});
  assert.equal(f.bank.receive(f.header,{...f.event,eventId:'0'}).duplicate,true);
});
test('bank state and dedup survive reopening database',t => {
  const f = fixture(t), event = f.bank.receive(f.header,f.event);
  const ledger = new Ledger(f.file);
  try {
    const bank = new BankInbox(ledger,{now:()=>now});
    assert.equal(bank.receive(f.header,f.event).id,event.id);
    assert.equal(bank.list().total,1);
  } finally {ledger.close();}
});
function request(data,headers = {},method = 'POST') {
  const stream = Readable.from([Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))]);
  stream.method = method;stream.headers = {'content-type':'application/json',...headers};return stream;
}
test('bank HTTP handler enforces token, JSON limits and session revalidation',async t => {
  const f = fixture(t), module = createModule(f.file,{now:()=>now});t.after(() => module.close());
  assert.equal((await module.publicHandle({request:request(f.event)})).status,401);
  assert.equal((await module.publicHandle({request:request(f.event,{authorization:f.header},'GET')})).status,405);
  assert.equal((await module.publicHandle({request:request(f.event,{authorization:f.header,'content-type':'text/plain'})})).status,415);
  assert.equal((await module.publicHandle({request:request('{',{authorization:f.header})})).status,400);
  assert.equal((await module.publicHandle({request:request('x'.repeat(9000),{authorization:f.header})})).status,413);
  const response = await module.publicHandle({request:request(f.event,{authorization:f.header})});
  assert.equal(response.status,200);assert.equal((await response.json()).state,'pending');
  for (const route of ['/bank/source','/bank/revoke','/bank/resolve']) assert.equal((await module.handle({request:request({}, {}, 'GET'),path:route})).status,404);
  const result = await module.handle({request:request({id:f.source.id}),path:'/bank/revoke',authorized:()=>false});
  assert.equal(result.status,401);assert.equal(f.bank.sources()[0].enabled,1);
});

test('bank rejects reused notification ID with changed contents and deduplicates after source rotation',t => {
  const f = fixture(t), first = f.bank.receive(f.header,f.event);
  assert.throws(() => f.bank.receive(f.header,{...f.event,text:'Покупка 999 RUB'}),{status:409});
  f.bank.revoke(f.source.id);
  const replacement = f.bank.create({name:'Новый ключ',package:f.event.package,zone:'UTC',account:f.transaction.account});
  assert.equal(f.bank.receive('Bearer '+replacement.token,f.event).id,first.id);
  assert.equal(f.bank.list().total,1);
});
test('bank end-to-end HTTP ingestion needs no login but never grants access to financial history',async t => {
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {passwordHash} = await import('../02-hub/src/auth.mjs');
  const f = fixture(t), module = createModule(f.file,{now:()=>now});
  const config = {username:'admin',origin:'https://hub.example.com',...await passwordHash('password-for-tests-123')};
  const app = createApp({config,modules:new Map([['balance',{id:'balance',title:'Плутос',description:'',...module}]])});
  await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
  t.after(async () => {app.closeAllConnections();await new Promise(resolve => app.close(resolve));module.close();});
  const base = 'http://127.0.0.1:'+app.address().port;
  const headers = {'Content-Type':'application/json',Authorization:f.header};
  const post = (url,data,extra = {}) => fetch(base+url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data),redirect:'manual'});
  const receive = await post('/api/balance/notifications',f.event);
  assert.equal(receive.status,200);assert.equal(receive.headers.get('cache-control'),'no-store');
  const id = (await receive.json()).id;
  assert.equal((await fetch(base+'/modules/balance/bank/inbox',{headers,redirect:'manual'})).status,303);
  assert.equal((await post('/modules/balance/bank/revoke',{id:f.source.id})).status,403);
  const login = await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/x-www-form-urlencoded'},body:'username=admin&password=password-for-tests-123',redirect:'manual'});
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const auth = {Cookie,Origin:config.origin};
  assert.equal((await post('/modules/balance/bank/resolve',{id,action:'accept',transaction:f.transaction},{...auth,Origin:'https://evil.example'})).status,403);
  const approvals = await Promise.all(Array.from({length:5},() => post('/modules/balance/bank/resolve',{id,action:'accept',transaction:f.transaction},auth)));
  assert.ok(approvals.every(r => r.status === 200));assert.equal(f.ledger.accounts()[0].balance,-35050);
  assert.equal((await post('/modules/balance/bank/revoke',{id:f.source.id},auth)).status,200);
  assert.equal((await post('/api/balance/notifications',f.event)).status,401);
});

test('structured APK operations are validated, deduplicated and retain no original notification text',t=>{
 const f=fixture(t),data={eventId:'apk-event',package:f.event.package,occurredAt:now,operation:{kind:'expense',amountMinor:45050,currency:'RUB'}};
 const event=f.bank.receive(f.header,data);assert.equal(f.bank.receive(f.header,data).id,event.id);
 assert.equal(event.state,'accepted');const row=f.ledger.record('transactions',event.transactionId);assert.equal(row.amount,45050);assert.equal(row.note,'Покупка · Телефон');assert.equal(f.ledger.record('bank_events',event.id).text,'');
 for(const operation of [{kind:'transfer',amountMinor:3,currency:'RUB'},{kind:'expense',amountMinor:1.5,currency:'RUB'},{kind:'expense',amountMinor:-2,currency:'RUB'},{kind:'expense',amountMinor:2,currency:'FAKE'}])assert.throws(()=>f.bank.receive(f.header,{...data,operation}),{status:400});
 assert.throws(()=>f.bank.receive(f.header,{...data,text:'original text'}),{status:400});
 for(const merchant of [5,'x'.repeat(161),'shop\nsecret'])assert.throws(()=>f.bank.receive(f.header,{...data,operation:{...data.operation,merchant}}),{status:400});
});
test('APK handshake validates token and reports only allowed source without financial data',async t=>{
 const f=fixture(t),module=createModule(f.file,{now:()=>now});t.after(()=>module.close());
 const result=await module.publicHandle({request:request({type:'hello'},{authorization:f.header})});
 const {companion, ...hello}=await result.json();
 assert.deepEqual(hello,{state:'ready',package:'ru.example.bank',name:'Телефон',sms:true,operationKinds:['expense','income','refund']});
 const {createHash}=await import('node:crypto');
 assert.equal(companion.sha256, createHash('sha256').update(fs.readFileSync(new URL('../02-hub/modules/balance/companion.apk', import.meta.url))).digest('hex'));
 assert.ok(Number.isSafeInteger(companion.code) && companion.code > 0);
 assert.match(companion.version, /^\d+\.\d+\.\d+$/);
 f.bank.revoke(f.source.id);assert.equal((await module.publicHandle({request:request({type:'hello'},{authorization:f.header})})).status,401);
});

test('APK download requires a session and serves the signed packaged artifact',async t=>{
 const {createApp}=await import('../02-hub/src/server.mjs');const {passwordHash}=await import('../02-hub/src/auth.mjs');
 const f=fixture(t),module=createModule(f.file),config={username:'admin',origin:'https://hub.example.com',...await passwordHash('password-for-tests-123')};
 const app=createApp({config,modules:new Map([['balance',{id:'balance',title:'Плутос',description:'',...module}]])});await new Promise(r=>app.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));module.close();});
 const base='http://127.0.0.1:'+app.address().port;
 assert.equal((await fetch(base+'/modules/balance/companion.apk',{redirect:'manual'})).status,303);
 const login=await fetch(base+'/api/auth/login',{method:'POST',redirect:'manual',headers:{Origin:config.origin,'Content-Type':'application/x-www-form-urlencoded'},body:'username=admin&password=password-for-tests-123'});
 const response=await fetch(base+'/modules/balance/companion.apk',{headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}});
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/vnd.android.package-archive');
 const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.equals(fs.readFileSync(new URL('../02-hub/modules/balance/companion.apk',import.meta.url))));assert.equal(bytes.subarray(0,2).toString(),'PK');
});

test('APK purchase records merchant and balance atomically, repeated deliveries never charge twice',t=>{
 const f=fixture(t),data={eventId:'auto-merchant',package:f.event.package,occurredAt:now,operation:{kind:'expense',amountMinor:9999,currency:'RUB',merchant:'Магнолия'}};
 const revision=f.ledger.db.prepare('SELECT revision FROM state').get().revision;
 const first=f.bank.receive(f.header,data);assert.equal(first.state,'accepted');
 const row=f.ledger.record('transactions',first.transactionId);assert.equal(row.note,'Магнолия');assert.equal(row.amount,9999);assert.equal(row.account,f.transaction.account);assert.equal(row.date,'2026-10-01');
 assert.equal(f.ledger.accounts()[0].balance,-9999);assert.equal(f.bank.list().total,0);
 assert.equal(f.ledger.db.prepare('SELECT revision FROM state').get().revision,revision+1);
 for(let i=0;i<3;i++)assert.equal(f.bank.receive(f.header,data).duplicate,true);
 assert.equal(f.bank.receive(f.header,{...data,eventId:'reissued-same-time'}).duplicate,true);
 assert.equal(f.bank.receive(f.header,{...data,operation:{...data.operation,merchant:'Обновлённое название'}}).duplicate,true);
 assert.equal(f.ledger.accounts()[0].balance,-9999);
 assert.equal(f.bank.resolve({id:first.id,action:'accept',transaction:f.transaction}).transactionId,first.transactionId);
 f.ledger.db.prepare('DELETE FROM transactions WHERE id=?').run(first.transactionId);
 assert.equal(f.bank.receive(f.header,data).duplicate,true);assert.equal(f.ledger.accounts()[0].balance,0);
});
test('automatic purchases fall back to review for incompatible account or balance overflow',t=>{
 for(const mode of ['currency','archived','overflow']){
  const f=fixture(t),op={kind:'expense',amountMinor:9999,currency:mode==='currency'?'USD':'RUB',merchant:'Магазин'};
  if(mode==='archived')f.ledger.db.prepare('UPDATE accounts SET archived=1 WHERE id=?').run(f.transaction.account);
  if(mode==='overflow')f.ledger.db.prepare('UPDATE accounts SET opening=-999999999999 WHERE id=?').run(f.transaction.account);
  const result=f.bank.receive(f.header,{eventId:mode,package:f.event.package,occurredAt:now,operation:op});
  assert.equal(result.state,'pending');assert.equal(f.bank.list().items[0].text,'Магазин');
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,0);
 }
});
test('automatic write failure rolls back event so a delivery retry can succeed',t=>{
 const f=fixture(t),data={eventId:'retry-auto',package:f.event.package,occurredAt:now,operation:{kind:'expense',amountMinor:123,currency:'RUB',merchant:'Магазин'}};
 const save=f.ledger.saveTransaction;f.ledger.saveTransaction=()=>{throw Error('disk failure')};
 assert.throws(()=>f.bank.receive(f.header,data),/disk failure/);
 assert.equal(f.ledger.db.prepare('SELECT COUNT(*) n FROM bank_events').get().n,0);
 f.ledger.saveTransaction=save;assert.equal(f.bank.receive(f.header,data).state,'accepted');assert.equal(f.ledger.accounts()[0].balance,-123);
});

test('SMS automatically records once and validates channel',t=>{
 const f=fixture(t),data={eventId:'sms-1',channel:'sms',package:f.event.package,occurredAt:now,operation:{kind:'expense',amountMinor:9999,currency:'RUB',merchant:'Магазин'}};
 assert.equal(f.bank.receive(f.header,data).state,'accepted');assert.equal(f.bank.receive(f.header,data).duplicate,true);assert.equal(f.ledger.accounts()[0].balance,-9999);
 assert.throws(()=>f.bank.receive(f.header,{...data,channel:'bad'}),{status:400});assert.throws(()=>f.bank.receive(f.header,{...f.event,channel:'sms'}),{status:400});
});
test('SMS/push candidates go to review in either order without another automatic debit',t=>{
 for(const first of ['push','sms']){
  const f=fixture(t),data={eventId:'first',channel:first,package:f.event.package,occurredAt:now-30000,operation:{kind:'expense',amountMinor:9900,currency:'RUB',merchant:'Магазин'}};
  assert.equal(f.bank.receive(f.header,data).state,'accepted');
  const next=f.bank.receive(f.header,{...data,eventId:'second',channel:first==='sms'?'push':'sms',occurredAt:now});
  assert.equal(next.state,'pending');assert.match(f.bank.list().items[0].text,/Возможный повтор/);assert.equal(f.ledger.accounts()[0].balance,-9900);
  assert.equal(f.bank.receive(f.header,{...data,eventId:'different-purchase',occurredAt:now+1000,operation:{...data.operation,amountMinor:8800}}).state,'accepted');
 }
});

test('merchant rules categorize new push and SMS purchases using exact normalized names',t=>{
 const f=fixture(t),category=f.ledger.snapshot().categories.find(c=>c.name==='Продукты'&&c.kind==='expense').id;
 const rule=f.bank.saveRule({merchant:'Магазин у дома',category});
 const send=(merchant,n,channel='push')=>f.bank.receive(f.header,{eventId:'rule-'+n,channel,package:f.event.package,occurredAt:now+n,operation:{kind:'expense',amountMinor:100+n,currency:'RUB',merchant}});
 for(const [n,name,channel] of [[1,'  МАГАЗИН\u00a0 У  ДОМА ','push'],[2,'Магазин у дома','sms']]){
  const event=send(name,n,channel);assert.equal(event.state,'accepted');assert.equal(f.ledger.record('transactions',event.transactionId).category,category);
 }
 const other=send('Магазин у дома №2',3);assert.notEqual(f.ledger.record('transactions',other.transactionId).category,category);
 f.bank.deleteRule({...rule,version:1});assert.equal(f.bank.rules().length,0);
 assert.notEqual(f.ledger.record('transactions',send('Магазин у дома',4).transactionId).category,category);
 assert.equal(f.ledger.db.prepare('SELECT COUNT(*) n FROM transactions WHERE category=?').get(category).n,2);
});
test('rules persist, reject duplicate names and stale edits, and fall back for archived categories',t=>{
 const f=fixture(t),categories=f.ledger.snapshot().categories,category=categories.find(c=>c.name==='Продукты'&&c.kind==='expense').id;
 const id=f.bank.saveRule({merchant:'Магнолия',category}).id;
 assert.throws(()=>f.bank.saveRule({merchant:' МАГНОЛИЯ ',category}),{status:409});
 assert.throws(()=>f.bank.saveRule({merchant:'Income',category:categories.find(c=>c.kind==='income').id}),{status:400});
 f.bank.saveRule({id,version:1,merchant:'Магнолия',category});
 assert.throws(()=>f.bank.saveRule({id,version:1,merchant:'Другой магазин',category}),{status:409});
 assert.throws(()=>f.bank.deleteRule({id,version:1}),{status:409});
 assert.equal(new BankInbox(f.ledger).rules()[0].version,2);
 f.ledger.db.prepare('UPDATE categories SET archived=1 WHERE id=?').run(category);
 const event=f.bank.receive(f.header,{eventId:'archived-rule',package:f.event.package,occurredAt:now,operation:{kind:'expense',amountMinor:100,currency:'RUB',merchant:'Магнолия'}});
 assert.equal(event.state,'accepted');assert.notEqual(f.ledger.record('transactions',event.transactionId).category,category);
});
test('merchant rule writes revalidate session and cannot be made with the phone token',async t=>{
 const f=fixture(t),module=createModule(f.file);t.after(()=>module.close());
 const data={merchant:'Магнолия',category:f.transaction.category};
 const denied=await module.handle({request:request(data),path:'/bank/rule',authorized:()=>false});assert.equal(denied.status,401);assert.equal(f.bank.rules().length,0);
 const allowed=await module.handle({request:request(data),path:'/bank/rule',authorized:()=>true});assert.equal(allowed.status,200);assert.equal(f.bank.rules().length,1);
 const publicResult=await module.publicHandle({request:request({...data,type:'rule'},{authorization:f.header})});assert.equal(publicResult.status,400);
});

test('credits default to review, preserve operation kind and require matching ledger direction',t=>{
  const f=fixture(t);
  const event={eventId:'salary-1',package:f.event.package,occurredAt:now,operation:{kind:'income',amountMinor:5400000,currency:'RUB',merchant:'Работодатель'}};
  const result=f.bank.receive(f.header,event);
  assert.equal(result.state,'pending');assert.equal(f.ledger.accounts()[0].balance,0);
  assert.equal(f.bank.list().items[0].kind,'income');
  assert.throws(()=>f.bank.resolve({id:result.id,action:'accept',transaction:f.transaction}),{status:400});
  const category=f.ledger.snapshot().categories.find(c=>c.kind==='income').id;
  const input={id:result.id,action:'accept',transaction:{...f.transaction,kind:'income',category,amount:'54000'}};
  assert.equal(f.bank.resolve(input).state,'accepted');f.bank.resolve(input);
  assert.equal(f.ledger.accounts()[0].balance,5400000);
});
test('opt-in credits distinguish income, refund and expense, retry safely and leave purchases intact',t=>{
  const f=fixture(t);
  assert.equal(f.bank.sources()[0].auto_credits,0);
  f.bank.autoCredits({id:f.source.id,enabled:true});
  for(const kind of ['expense','income','refund']){
    const e={eventId:kind,package:f.event.package,occurredAt:now,operation:{kind,amountMinor:10000,currency:'RUB',merchant:'Магазин'}};
    assert.equal(f.bank.receive(f.header,e).state,'accepted');
    assert.equal(f.bank.receive(f.header,e).duplicate,true);
  }
  assert.equal(f.ledger.accounts()[0].balance,10000);
  const rows=f.ledger.db.prepare('SELECT t.kind,c.name FROM transactions t JOIN categories c ON c.id=t.category').all();
  assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.kind==='expense').length,1);
  assert.ok(rows.some(r=>r.kind==='income'&&r.name==='Возвраты покупок'));
});
test('enabling credits does not retrospectively approve pending events and currency mismatch remains pending',t=>{
  const f=fixture(t),event={eventId:'refund-pending',package:f.event.package,occurredAt:now,operation:{kind:'refund',amountMinor:9999,currency:'RUB'}};
  assert.equal(f.bank.receive(f.header,event).state,'pending');
  f.bank.autoCredits({id:f.source.id,enabled:true});
  assert.equal(f.bank.receive(f.header,event).state,'pending');
  assert.equal(f.bank.receive(f.header,{...event,eventId:'refund-usd',operation:{...event.operation,currency:'USD'}}).state,'pending');
  assert.equal(f.ledger.accounts()[0].balance,0);
  assert.throws(()=>f.bank.autoCredits({id:f.source.id,enabled:'yes'}),{status:400});
});
test('credit channels deduplicate conservatively without conflating opposite directions',t=>{
  const f=fixture(t);f.bank.autoCredits({id:f.source.id,enabled:true});
  const event={eventId:'credit-push',package:f.event.package,occurredAt:now,operation:{kind:'income',amountMinor:10000,currency:'RUB'}};
  assert.equal(f.bank.receive(f.header,event).state,'accepted');
  assert.equal(f.bank.receive(f.header,{...event,eventId:'credit-sms',channel:'sms',occurredAt:now+1000}).state,'pending');
  assert.equal(f.bank.receive(f.header,{...event,eventId:'expense-sms',channel:'sms',occurredAt:now+1000,operation:{...event.operation,kind:'expense'}}).state,'accepted');
  assert.equal(f.ledger.accounts()[0].balance,0);
});

test('credit preference requires hub authorization and persists across restart',async t=>{
 const f=fixture(t),module=createModule(f.file,{now:()=>now});t.after(()=>module.close());
 const call=authorized=>module.handle({request:request({id:f.source.id,enabled:true}),path:'/bank/auto-credits',authorized:()=>authorized});
 assert.equal((await call(false)).status,401);assert.equal(f.bank.sources()[0].auto_credits,0);
 assert.equal((await call(true)).status,200);
 const reopened=new BankInbox(f.ledger,{now:()=>now});assert.equal(reopened.sources()[0].auto_credits,1);
});
test('old bank tables migrate without changing historical expense state or enabling credit writes',t=>{
 const f=fixture(t);f.bank.receive(f.header,f.event);
 f.ledger.db.exec('ALTER TABLE bank_events DROP COLUMN kind; ALTER TABLE bank_sources DROP COLUMN auto_credits');
 const migrated=new BankInbox(f.ledger,{now:()=>now});
 assert.equal(migrated.sources()[0].auto_credits,0);assert.equal(migrated.list().items[0].kind,'expense');
 assert.equal(migrated.receive(f.header,f.event).duplicate,true);
});
