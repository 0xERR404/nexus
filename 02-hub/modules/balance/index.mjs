import {companion} from '../../src/companion.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {modulePage} from '../../src/views.mjs';
import {body} from '../../src/server.mjs';
import {Ledger} from './store.mjs';
import {BankInbox} from './bank.mjs';
import {Market} from './market.mjs';
import {combinedUsage} from '../../src/ai-usage.mjs';
const assets = new Map(
  ['balance.css', 'balance.js', 'bank.js'].map((name) => [
    '/' + name,
    fs.readFileSync(new URL(name, import.meta.url))
  ])
);
const assetsHTML =
  '<link rel="stylesheet" href="/modules/balance/balance.css"><script src="/modules/balance/balance.js" defer></script><script src="/modules/balance/bank.js" defer></script>';
const status =
  '<p id="balanceStatus" class="balance-status" role="status" aria-live="polite">Загрузка…</p>';
const field = (label, id, input) =>
  `<label class="balance-field" for="${id}"><span>${label}</span>${input}</label>`;
const select = (id, options = '') => `<select id="${id}">${options}</select>`;
const input = (id, extra = '') => `<input id="${id}" ${extra}>`;
const types =
  '<option value="expense">Расход</option><option value="income">Доход</option><option value="transfer">Перевод</option>';
const operationDialog = `<dialog id="balanceOperation" aria-labelledby="balanceOperationTitle"><form id="balanceOperationForm"><div class="balance-title"><h2 id="balanceOperationTitle">Новая операция</h2><button type="button" data-close="balanceOperation" class="dialog-close" aria-label="Закрыть">×</button></div><div class="balance-form-grid">${field('Тип', 'balanceKind', select('balanceKind', types))}${field('Дата', 'balanceDate', input('balanceDate', 'type="date" required'))}${field('Счёт', 'balanceAccount', select('balanceAccount'))}${field('Категория', 'balanceCategory', select('balanceCategory'))}${field('Сумма', 'balanceAmount', input('balanceAmount', 'inputmode="decimal" placeholder="0,00" maxlength="14" required'))}${field('На счёт', 'balanceTarget', select('balanceTarget'))}${field('Получено', 'balanceReceived', input('balanceReceived', 'inputmode="decimal" placeholder="0,00" maxlength="14"'))}<label class="balance-field balance-wide" for="balanceNote"><span>Комментарий</span><input id="balanceNote" maxlength="300" autocomplete="off"></label></div><p id="balanceOperationError" class="balance-error" role="alert"></p><div class="balance-actions"><button class="balance-primary" type="submit">Сохранить</button><button type="button" data-close="balanceOperation">Отмена</button></div></form></dialog>`;
const deleteDialog = `<dialog id="balanceDeleteDialog" aria-labelledby="balanceDeleteTitle" aria-describedby="balanceDeleteDetails balanceDeleteHelp"><form id="balanceDeleteForm"><div class="balance-title"><h2 id="balanceDeleteTitle">Удалить операцию?</h2><button type="button" data-close="balanceDeleteDialog" class="dialog-close" aria-label="Закрыть">×</button></div><p id="balanceDeleteDetails"></p><p id="balanceDeleteHelp">Остатки счетов будут пересчитаны.</p><p id="balanceDeleteError" class="balance-error" role="alert"></p><div class="balance-actions"><button id="balanceDeleteCancel" type="button" data-close="balanceDeleteDialog" autofocus>Отмена</button><button class="balance-danger" type="submit">Удалить</button></div></form></dialog>`;
const insights = `<div class="balance-insights"><section class="balance-panel"><div class="balance-title"><h2>Валюты</h2><span>₽ за 1</span></div><div id="balanceFiat" class="balance-quotes">Загрузка…</div><p id="balanceFiatDate" class="balance-source" hidden></p></section><section class="balance-panel"><div class="balance-title"><h2>Криптовалюты</h2><span>USD</span></div><div id="balanceCrypto" class="balance-quotes">Загрузка…</div><p id="balanceCryptoDate" class="balance-source" hidden></p></section><section class="balance-panel balance-ai"><div class="balance-title"><h2>ИИ · остатки</h2></div><div id="balanceAI"><div class="balance-credit-row"><span>DeepSeek</span><strong id="balanceCredit">—</strong></div><div class="balance-credit-row"><span>FlowMusic</span><strong id="balanceFlowCredit">—</strong></div></div></section></div>`;
const bankInbox = `<section class="balance-panel" id="bankInbox"><div class="balance-title"><h2>Банковские уведомления <span id="bankCount"></span></h2><button id="bankRefresh" type="button">Обновить</button></div><p class="balance-help">Поступления и возвраты по умолчанию ждут проверки. Автозапись включается в настройках источника. Переводы между своими счетами учитывай отдельно.</p><p id="bankStatus" class="balance-help" role="status"></p><div id="bankEvents"></div><div class="balance-actions"><button id="bankPrev" type="button">← Назад</button><button id="bankNext" type="button">Далее →</button></div></section><dialog id="bankReview"><form id="bankReviewForm"><div class="balance-title"><h2>Проверить операцию</h2><button type="button" id="bankReviewClose" class="dialog-close" aria-label="Закрыть">×</button></div><p id="bankReviewText" class="bank-message"></p><div class="balance-form-grid">${field('Счёт', 'bankAccount', select('bankAccount'))}${field('Категория', 'bankCategory', select('bankCategory'))}${field('Дата', 'bankDate', input('bankDate', 'type="date" required'))}${field('Сумма в валюте счёта', 'bankAmount', input('bankAmount', 'inputmode="decimal" maxlength="14" required'))}${field('Комментарий', 'bankNote', input('bankNote', 'maxlength="300"'))}</div><p id="bankReviewError" role="alert" class="balance-error"></p><div class="balance-actions"><button type="submit">Записать операцию</button><button id="bankDismiss" type="button">Пропустить</button></div></form></dialog>`;
const bankSettings = `<section class="balance-panel" id="bankSettings"><div class="balance-title"><h2>Талос</h2><a href="/modules/balance/companion.apk" download>Скачать APK</a></div><p class="balance-help">Android 8 или новее. В Сбере выбери стиль уведомлений «Стандарт». Установи Талос, выбери банковское приложение и скопируй его ID. Создай источник ниже, затем укажи в приложении адрес хаба и ключ. Одна установка Талоса подключает один банк. Распознанные покупки из Талоса записываются автоматически на выбранный счёт, с категорией по правилу магазина (иначе «Другое») и названием магазина, если оно есть в уведомлении. Проблемные операции остаются во входящих. Зарплата и возвраты сначала требуют проверки; после сверки включи их автозапись у источника. Возвраты учитываются отдельным доходом, исходная покупка не изменяется. Ключ позволяет отправлять операции, но не читать счета и историю.</p><form id="bankSourceForm"><div class="balance-form-grid">${field('Название источника', 'bankSourceName', input('bankSourceName', 'maxlength="60" placeholder="Телефон · банк" required'))}${field('Приложение банка (package ID)', 'bankPackage', input('bankPackage', 'maxlength="160" placeholder="com.example.bank" required'))}${field('Счёт по умолчанию', 'bankSourceAccount', select('bankSourceAccount'))}${field('Часовой пояс', 'bankZone', input('bankZone', 'maxlength="80" required'))}</div><div class="balance-actions"><button type="submit">Подключить источник</button></div></form><p id="bankStatus" role="status" class="balance-help"></p><div id="bankConnection" hidden><p class="balance-help">Скопируй ключ сейчас: повторно он не показывается. При утрате отзови источник и создай новый.</p>${field('Адрес хаба для Талоса', 'bankEndpoint', input('bankEndpoint', 'readonly'))}${field('Ключ источника', 'bankAuthorization', input('bankAuthorization', 'readonly type="password" autocomplete="off"'))}<div class="balance-actions"><button id="bankCopyConnection" type="button">Копировать ключ</button><button id="bankHideConnection" type="button">Скрыть ключ</button></div></div><div id="bankSources"></div><section class="balance-panel"><h3>Магазины → категории</h3><p class="balance-help">Правила действуют для новых покупок из пушей и SMS. Укажи название из комментария операции. Регистр и лишние пробелы не учитываются; остальное название должно совпадать целиком. Без правила или при архивной категории используется «Другое».</p><form id="bankRuleForm"><div class="balance-form-grid">${field('Магазин', 'bankRuleMerchant', input('bankRuleMerchant', 'maxlength="160" placeholder="Магнолия" required'))}${field('Категория расходов', 'bankRuleCategory', select('bankRuleCategory'))}</div><div class="balance-actions"><button type="submit" id="bankRuleSave">Добавить правило</button><button type="button" id="bankRuleCancel" hidden>Отмена</button></div></form><div id="bankRules"></div></section><dialog id="bankRuleDelete"><h3>Удалить правило?</h3><p id="bankRuleDeleteName"></p><p class="balance-help">Существующие операции сохранят свои категории.</p><div class="balance-actions"><button id="bankRuleDeleteCancel" type="button">Отмена</button><button id="bankRuleDeleteConfirm" type="button">Удалить</button></div></dialog><details><summary>Другие способы подключения</summary><p class="balance-help">В Android-автоматизации выбери только приложение банка и уведомления о покупках. Отправляй JSON на /api/balance/notifications через HTTPS с Content-Type: application/json и Authorization: Bearer КЛЮЧ. Сохраняй eventId и время при повторе. Коды входа и подтверждения не отправляй. При потере сети очередь и повторы настраиваются в автоматизации телефона.</p><pre class="bank-message">{"eventId":"стабильный-id-уведомления","package":"com.example.bank","occurredAt":"2026-09-30T12:00:00+03:00","text":"Покупка 350,00 RUB. Магазин"}</pre><p class="balance-help">Ответ pending означает только приём во входящие. Для проверки связи отправь тестовое уведомление с текущим временем, открой Плутос и нажми «Пропустить»: баланс не изменится. Этот способ с полем text требует ручного подтверждения; покупки APK записываются автоматически, поступления и возвраты — согласно настройке источника. Пока источник не настроен на телефоне, автоматической передачи нет.</p></details></section>`;
const content = `${assetsHTML}<div id="balancePage">${status}<div class="balance-toolbar"><label class="balance-field" for="balanceMonth"><span>Месяц</span><input id="balanceMonth" type="month" required></label><button id="balanceNew" class="balance-primary" type="button">Добавить операцию</button></div><section id="balanceTotals" class="balance-totals" aria-label="Сводка"></section>${insights}<section class="balance-panel"><div class="balance-title"><h2>Счета</h2></div><div id="balanceAccounts" class="balance-accounts"></div></section><section class="balance-panel"><div class="balance-title"><h2>История</h2><span id="balanceCount"></span></div><div class="balance-filters">${field('Счёт', 'balanceFilterAccount', select('balanceFilterAccount', '<option value="">Все счета</option>'))}${field('Тип', 'balanceFilterKind', select('balanceFilterKind', '<option value="">Все операции</option>' + types))}</div><div id="balanceTransactions"></div><div class="balance-pagination"><button id="balancePrev" type="button">← Назад</button><span id="balancePageNumber"></span><button id="balanceNext" type="button">Далее →</button></div></section>${bankInbox}${operationDialog}${deleteDialog}</div>`;
const accountDialog = `<dialog id="balanceAccountDialog" aria-labelledby="balanceAccountTitle"><form id="balanceAccountForm"><div class="balance-title"><h2 id="balanceAccountTitle">Новый счёт</h2><button type="button" data-close="balanceAccountDialog" class="dialog-close" aria-label="Закрыть">×</button></div><div class="balance-form-grid">${field('Название', 'balanceAccountName', input('balanceAccountName', 'maxlength="60" required'))}${field('Тип', 'balanceAccountKind', select('balanceAccountKind', '<option value="card">Карта</option><option value="cash">Наличные</option><option value="savings">Накопления</option>'))}${field('Валюта', 'balanceCurrency', select('balanceCurrency', '<option>RUB</option><option>USD</option><option>EUR</option>'))}${field('Начальный остаток', 'balanceOpening', input('balanceOpening', 'inputmode="decimal" maxlength="15" required'))}</div><p class="balance-help" id="balanceOpeningHelp">Остаток до первой записанной операции.</p><p id="balanceAccountError" class="balance-error" role="alert"></p><div class="balance-actions"><button class="balance-primary" type="submit">Сохранить</button><button type="button" data-close="balanceAccountDialog">Отмена</button></div></form></dialog>`;
const categoryDialog = `<dialog id="balanceCategoryDialog" aria-labelledby="balanceCategoryTitle"><form id="balanceCategoryForm"><div class="balance-title"><h2 id="balanceCategoryTitle">Новая категория</h2><button type="button" data-close="balanceCategoryDialog" class="dialog-close" aria-label="Закрыть">×</button></div><div class="balance-form-grid">${field('Название', 'balanceCategoryName', input('balanceCategoryName', 'maxlength="50" required'))}${field('Тип', 'balanceCategoryKind', select('balanceCategoryKind', '<option value="expense">Расход</option><option value="income">Доход</option>'))}</div><p id="balanceCategoryError" class="balance-error" role="alert"></p><div class="balance-actions"><button class="balance-primary" type="submit">Сохранить</button><button type="button" data-close="balanceCategoryDialog">Отмена</button></div></form></dialog>`;
export const settings = {
  title: 'Плутос',
  content: `${assetsHTML}<div id="balanceSettings">${status}<section class="balance-panel"><div class="balance-title"><h2>Счета</h2><button id="balanceAddAccount" type="button">Добавить счёт</button></div><div id="balanceManageAccounts"></div><p class="balance-help">Архивировать можно только счёт с нулевым остатком. История сохраняется.</p></section><section class="balance-panel"><div class="balance-title"><h2>Категории</h2><button id="balanceAddCategory" type="button">Добавить категорию</button></div><div id="balanceManageCategories" class="balance-category-grid"></div></section><section class="balance-panel"><div class="balance-title"><h2>Курсы криптовалют</h2></div><form id="balanceMarketForm"><label class="balance-field" for="balanceMarketKey"><span>CoinGecko Demo API key · необязательно</span><input id="balanceMarketKey" type="password" autocomplete="new-password" maxlength="160" placeholder="Новый ключ"></label><p id="balanceMarketState" class="balance-help"></p><p class="balance-help">Для повышения лимита запросов. Пустое поле сохраняет ключ.</p><div class="balance-actions"><button type="submit">Сохранить</button><button id="balanceMarketRemove" type="button">Удалить ключ</button></div><p id="balanceMarketError" class="balance-error" role="status"></p></form></section>${bankSettings}${accountDialog}${categoryDialog}</div>`
};
export function createModule(
  file = path.join(process.env.DATA_DIR ?? '/app/data', 'balance', 'ledger.sqlite'),
  options = {}
) {
  const market = new Market(path.dirname(file), options);
  const chatDirectory =
    options.chatDirectory ?? path.join(path.dirname(path.dirname(file)), 'chat');
  let ledger, bank;
  const store = () => (ledger ??= new Ledger(file));
  const inbox = () => (bank ??= new BankInbox(store(), options));
  return {
    async publicHandle({request}) {
      try {
        if (request.method !== 'POST') return Response.json({error: 'Нужен POST'}, {status: 405});
        inbox().authenticate(request.headers.authorization);
        if (!request.headers['content-type']?.startsWith('application/json'))
          return Response.json({error: 'Ожидается JSON'}, {status: 415});
        let data;
        try {
          data = JSON.parse(await body(request, 8192));
        } catch (error) {
          return Response.json({error: 'Некорректный JSON'}, {status: error.status ?? 400});
        }
        if (!data || typeof data !== 'object' || Array.isArray(data))
          return Response.json({error: 'Некорректный запрос'}, {status: 400});
        if (data.type === 'hello') {
          const source = inbox().authenticate(request.headers.authorization);
          return Response.json({
            state: 'ready',
            companion: companion(),
            package: source.package,
            name: source.name,
            sms: true,
            operationKinds: ['expense', 'income', 'refund']
          });
        }
        return Response.json(inbox().receive(request.headers.authorization, data));
      } catch (error) {
        return Response.json(
          {error: error.status ? error.message : 'Приём временно недоступен'},
          {status: error.status ?? 503}
        );
      }
    },
    close() {
      ledger?.close();
      ledger = undefined;
      bank = undefined;
    },
    async handle({
      request,
      path: route,
      user,
      authorized = () => true,
      searchParams = new URLSearchParams()
    }) {
      try {
        if (['GET', 'HEAD'].includes(request.method)) {
          if (route === '/')
            return new Response(modulePage({embedded: user.embedded, username: user.username, title: 'Плутос', content}), {
              headers: {'Content-Type': 'text/html; charset=utf-8'}
            });
          if (assets.has(route))
            return new Response(assets.get(route), {
              headers: {
                'Content-Type': route.endsWith('.css')
                  ? 'text/css; charset=utf-8'
                  : 'text/javascript; charset=utf-8'
              }
            });
          if (route === '/companion.apk') {
            const apk = fs.readFileSync(new URL('companion.apk', import.meta.url));
            return new Response(request.method === 'HEAD' ? null : apk, {
              headers: {
                'Content-Type': 'application/vnd.android.package-archive',
                'Content-Disposition': `attachment; filename="nexus404-talos-${companion()?.version ?? 'download'}.apk"`,
                'Content-Length': String(apk.length),
                'Cache-Control': 'private, no-store',
                'X-Checksum-SHA256': createHash('sha256').update(apk).digest('hex')
              }
            });
          }
          if (route === '/rates') return Response.json(await market.rates());
          if (route === '/ai')
            return Response.json(
              combinedUsage([
                path.join(chatDirectory, 'chat.sqlite'),
                path.join(chatDirectory, '../rhythm/rhythm.sqlite')
              ])
            );
          if (route === '/credit') return Response.json(await market.credit(chatDirectory));
          if (!authorized()) return Response.json({error: 'Сессия завершена'}, {status: 401});
          if (route === '/market-config') return Response.json(market.publicConfig());
          if (route === '/bank/sources')
            return Response.json({items: inbox().sources(), rules: inbox().rules()});
          if (route === '/bank/inbox')
            return Response.json(inbox().list(Number(searchParams.get('offset') ?? 0)));
          if (route === '/api') return Response.json(store().snapshot(searchParams));
        } else if (
          request.method === 'POST' &&
          [
            '/mutate',
            '/market-config',
            '/bank/source',
            '/bank/auto-credits',
            '/bank/revoke',
            '/bank/resolve',
            '/bank/rule',
            '/bank/rule-delete'
          ].includes(route)
        ) {
          if (!request.headers['content-type']?.startsWith('application/json'))
            return Response.json({error: 'Ожидается JSON'}, {status: 415});
          let data;
          try {
            data = JSON.parse(await body(request, 8192));
          } catch (error) {
            return Response.json(
              {error: error.status === 413 ? 'Слишком большой запрос' : 'Некорректный JSON'},
              {status: error.status ?? 400}
            );
          }
          if (!data || typeof data !== 'object' || Array.isArray(data))
            return Response.json({error: 'Некорректный запрос'}, {status: 400});
          if (!authorized()) return Response.json({error: 'Сессия завершена'}, {status: 401});
          if (route === '/bank/rule') return Response.json(inbox().saveRule(data));
          if (route === '/bank/rule-delete') return Response.json(inbox().deleteRule(data));
          if (route === '/bank/source') return Response.json(inbox().create(data));
          if (route === '/bank/auto-credits') return Response.json(inbox().autoCredits(data));
          if (route === '/bank/revoke') return Response.json(inbox().revoke(data.id));
          if (route === '/bank/resolve') return Response.json(inbox().resolve(data));
          if (route === '/market-config') return Response.json(market.saveConfig(data));
          return Response.json(store().mutate(data));
        }
        return Response.json({error: 'Маршрут не найден'}, {status: 404});
      } catch (error) {
        if (!error.status) console.error('Balance storage unavailable:', error.code ?? 'storage');
        return Response.json(
          {
            error: error.status
              ? error.message
              : 'Не удалось прочитать или сохранить данные «Плутоса». Повтори позже.'
          },
          {status: error.status ?? 503}
        );
      }
    },
    async summary() {
      const totals = store().totals();
      return {
        state: 'ok',
        chart: store().history()[0],
        items: totals.map(({currency, amount}) => ({
          label: currency,
          value: new Intl.NumberFormat('ru-RU', {
            maximumFractionDigits: 2,
            notation: Math.abs(amount) >= 100000000 ? 'compact' : 'standard'
          }).format(amount / 100)
        }))
      };
    }
  };
}
const module = createModule();
export const handle = module.handle;
export const summary = module.summary;

export const publicHandle = module.publicHandle;
export const close = module.close;
