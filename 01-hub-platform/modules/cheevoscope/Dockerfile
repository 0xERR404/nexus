FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# steam-user (используется для входа как владелец аккаунта — обходит
# фильтр skip_unvetted_apps, недоступный в публичном REST API, см.
# lib/steamClientApi.js) — чистый JS, без нативной сборки, поэтому
# build-base/python3 тут не нужны, обычный npm ci на alpine отрабатывает.
# overrides в package.json — форсируют patched-версии transitive-
# зависимостей (protobufjs/adm-zip), у steam-user@5.3.0 они по умолчанию
# тянут уязвимые версии (npm audit подтверждал 3 high + 1 critical до
# override, 0 после — проверено). npm ci (не install) + закоммиченный
# package-lock.json — иначе резолвится заново при каждой сборке образа
# и на этот конкретный набор зафиксированных версий полагаться нельзя.
RUN npm ci --omit=dev --no-audit --no-fund
COPY chrome.js ./
COPY index.js ./
COPY lib/ ./lib/
EXPOSE 4006
CMD ["node", "index.js"]
