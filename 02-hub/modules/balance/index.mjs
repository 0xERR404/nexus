import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {body} from '../../src/server.mjs';
import {Ledger} from './store.mjs';
import {Market} from './market.mjs';
import {usageSnapshot} from '../../src/ai-usage.mjs';
const assets = new Map(
  ['balance.css', 'balance.js'].map((name) => [
    '/' + name,
    fs.readFileSync(new URL(name, import.meta.url))
  ])
);
const assetsHTML =
  '<link rel="stylesheet" href="/modules/balance/balance.css"><script src="/modules/balance/balance.js" defer></script>';
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
const insights = `<div class="balance-insights"><section class="balance-panel"><div class="balance-title"><h2>Валюты</h2><span>₽ за 1</span></div><div id="balanceFiat" class="balance-quotes">Загрузка…</div><p id="balanceFiatDate" class="balance-source"></p></section><section class="balance-panel"><div class="balance-title"><h2>Криптовалюты</h2><span>USD</span></div><div id="balanceCrypto" class="balance-quotes">Загрузка…</div><p id="balanceCryptoDate" class="balance-source"></p></section><section class="balance-panel balance-ai"><div class="balance-title"><h2>Расходы ИИ</h2><select id="balanceAIPeriod" aria-label="Период расходов ИИ"><option value="hour">1 час</option><option value="day">24 часа</option><option value="month" selected>30 дней</option><option value="all">Всё время</option></select></div><div id="balanceAI">Загрузка…</div><p id="balanceCredit" class="balance-source"></p><details class="balance-source"><summary>Об учёте</summary><p id="balanceTariffDate"></p><p>Только обращения из NEXUS404. Оценка не меняет остатки счетов. Неизвестная стоимость не считается нулевой.</p></details></section></div>`;
const content = `${assetsHTML}<div id="balancePage">${status}<div class="balance-toolbar"><label class="balance-field" for="balanceMonth"><span>Месяц</span><input id="balanceMonth" type="month" required></label><button id="balanceNew" class="balance-primary" type="button">Добавить операцию</button></div><section id="balanceTotals" class="balance-totals" aria-label="Сводка"></section>${insights}<section class="balance-panel"><div class="balance-title"><h2>Счета</h2></div><div id="balanceAccounts" class="balance-accounts"></div></section><section class="balance-panel"><div class="balance-title"><h2>История</h2><span id="balanceCount"></span></div><div class="balance-filters">${field('Счёт', 'balanceFilterAccount', select('balanceFilterAccount', '<option value="">Все счета</option>'))}${field('Тип', 'balanceFilterKind', select('balanceFilterKind', '<option value="">Все операции</option>' + types))}</div><div id="balanceTransactions"></div><div class="balance-pagination"><button id="balancePrev" type="button">← Назад</button><span id="balancePageNumber"></span><button id="balanceNext" type="button">Далее →</button></div></section>${operationDialog}${deleteDialog}</div>`;
const accountDialog = `<dialog id="balanceAccountDialog" aria-labelledby="balanceAccountTitle"><form id="balanceAccountForm"><div class="balance-title"><h2 id="balanceAccountTitle">Новый счёт</h2><button type="button" data-close="balanceAccountDialog" class="dialog-close" aria-label="Закрыть">×</button></div><div class="balance-form-grid">${field('Название', 'balanceAccountName', input('balanceAccountName', 'maxlength="60" required'))}${field('Тип', 'balanceAccountKind', select('balanceAccountKind', '<option value="card">Карта</option><option value="cash">Наличные</option><option value="savings">Накопления</option>'))}${field('Валюта', 'balanceCurrency', select('balanceCurrency', '<option>RUB</option><option>USD</option><option>EUR</option>'))}${field('Начальный остаток', 'balanceOpening', input('balanceOpening', 'inputmode="decimal" maxlength="15" required'))}</div><p class="balance-help" id="balanceOpeningHelp">Остаток до первой записанной операции.</p><p id="balanceAccountError" class="balance-error" role="alert"></p><div class="balance-actions"><button class="balance-primary" type="submit">Сохранить</button><button type="button" data-close="balanceAccountDialog">Отмена</button></div></form></dialog>`;
const categoryDialog = `<dialog id="balanceCategoryDialog" aria-labelledby="balanceCategoryTitle"><form id="balanceCategoryForm"><div class="balance-title"><h2 id="balanceCategoryTitle">Новая категория</h2><button type="button" data-close="balanceCategoryDialog" class="dialog-close" aria-label="Закрыть">×</button></div><div class="balance-form-grid">${field('Название', 'balanceCategoryName', input('balanceCategoryName', 'maxlength="50" required'))}${field('Тип', 'balanceCategoryKind', select('balanceCategoryKind', '<option value="expense">Расход</option><option value="income">Доход</option>'))}</div><p id="balanceCategoryError" class="balance-error" role="alert"></p><div class="balance-actions"><button class="balance-primary" type="submit">Сохранить</button><button type="button" data-close="balanceCategoryDialog">Отмена</button></div></form></dialog>`;
export const settings = {
  title: 'Финансы',
  content: `${assetsHTML}<div id="balanceSettings">${status}<section class="balance-panel"><div class="balance-title"><h2>Счета</h2><button id="balanceAddAccount" type="button">Добавить счёт</button></div><div id="balanceManageAccounts"></div><p class="balance-help">Архивировать можно только счёт с нулевым остатком. История сохраняется.</p></section><section class="balance-panel"><div class="balance-title"><h2>Категории</h2><button id="balanceAddCategory" type="button">Добавить категорию</button></div><div id="balanceManageCategories" class="balance-category-grid"></div></section><section class="balance-panel"><div class="balance-title"><h2>Курсы криптовалют</h2></div><form id="balanceMarketForm"><label class="balance-field" for="balanceMarketKey"><span>CoinGecko Demo API key · необязательно</span><input id="balanceMarketKey" type="password" autocomplete="new-password" maxlength="160" placeholder="Новый ключ"></label><p id="balanceMarketState" class="balance-help"></p><p class="balance-help">Для повышения лимита запросов. Пустое поле сохраняет ключ.</p><div class="balance-actions"><button type="submit">Сохранить</button><button id="balanceMarketRemove" type="button">Удалить ключ</button></div><p id="balanceMarketError" class="balance-error" role="status"></p></form></section>${accountDialog}${categoryDialog}</div>`
};
export function createModule(
  file = path.join(process.env.DATA_DIR ?? '/app/data', 'balance', 'ledger.sqlite'),
  options = {}
) {
  const market = new Market(path.dirname(file), options);
  const chatDirectory =
    options.chatDirectory ?? path.join(path.dirname(path.dirname(file)), 'chat');
  let ledger;
  const store = () => (ledger ??= new Ledger(file));
  return {
    close() {
      ledger?.close();
      ledger = undefined;
    },
    async handle({request, path: route, user, searchParams = new URLSearchParams()}) {
      try {
        if (['GET', 'HEAD'].includes(request.method)) {
          if (route === '/')
            return new Response(modulePage({username: user.username, title: 'Баланс', content}), {
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
          if (route === '/rates') return Response.json(await market.rates());
          if (route === '/ai')
            return Response.json(usageSnapshot(path.join(chatDirectory, 'chat.sqlite')));
          if (route === '/credit') return Response.json(await market.credit(chatDirectory));
          if (route === '/market-config') return Response.json(market.publicConfig());
          if (route === '/api') return Response.json(store().snapshot(searchParams));
        } else if (request.method === 'POST' && ['/mutate', '/market-config'].includes(route)) {
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
              : 'Не удалось прочитать или сохранить данные «Баланса». Повтори позже.'
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
