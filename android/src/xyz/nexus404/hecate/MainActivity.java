package xyz.nexus404.hecate;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.job.JobScheduler;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import java.net.URI;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.json.JSONObject;

public final class MainActivity extends Activity {
  private final android.content.SharedPreferences.OnSharedPreferenceChangeListener changes =
      (prefs, key) -> {
        if (key != null && !key.startsWith("band")) runOnUiThread(() -> renderStatus());
      };
  private LinearLayout layout;
  private EditText origin, token;
  private TextView status, bankLabel, bankSummary;
  private Button connect, pause;
  private String bank = "";
  private boolean working;

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  public void onCreate(Bundle state) {
    super.onCreate(state);
    Vault.retireExtras(this);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setFitsSystemWindows(true);
    layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    layout.setPadding(dp(12), dp(12), dp(12), dp(20));
    scroll.setBackground(new HubBackground());
    scroll.addView(layout);
    setContentView(scroll);
    label("NEXUS404", 21, Color.WHITE).setTypeface(android.graphics.Typeface.MONOSPACE);
    label("ГЕКАТА · деньги и браслет · " + Vault.version(this), 11, 0xff9ba8b9);
    bandPanel();
    LinearLayout root = layout;
    layout = card(root);
    label("ПЛУТОС / операции", 15, 0xffd5dde8);
    LinearLayout bankCard = layout, bankOptions = new LinearLayout(this);
    bankOptions.setOrientation(LinearLayout.VERTICAL);
    bankOptions.setVisibility(View.GONE);
    action(
        "Настроить банк",
        () ->
            bankOptions.setVisibility(
                bankOptions.getVisibility() == View.GONE ? View.VISIBLE : View.GONE));
    layout.addView(bankOptions);
    layout = bankOptions;
    label(
        "Сбер: «Стандарт» · покупки автоматически · зарплата и возвраты по настройке источника в"
            + " хабе",
        13,
        0xff9ba8b9);
    origin = field("Адрес хаба · https://nexus404.xyz", false);
    token = field("Ключ источника из настроек Плутоса", true);
    bankLabel = label("Банк не выбран", 13, 0xffd5dde8);
    action("Выбрать банковское приложение", () -> chooseBank());
    action(
        "Скопировать ID приложения",
        () -> {
          if (bank.isEmpty()) {
            message("Сначала выбери приложение");
            return;
          }
          ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE))
              .setPrimaryClip(ClipData.newPlainText("ID приложения", bank));
          message("ID скопирован. Укажи его при создании источника в Плутосе.");
        });
    connect = action("Подключить к хабу", () -> connect());
    action(
        "Разрешить доступ к уведомлениям",
        () -> {
          try {
            startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
          } catch (Exception e) {
            message("Открой настройки Android → Доступ к уведомлениям");
          }
        });
    action("Канал операций: пуши / SMS", () -> smsSettings());
    layout = bankCard;
    bankSummary = label("", 12, 0xffd5dde8);
    status = label("", 12, 0xffd5dde8);
    status.setVisibility(View.GONE);
    action(
        "Диагностика банка",
        () -> status.setVisibility(status.getVisibility() == View.GONE ? View.VISIBLE : View.GONE));
    action("Проверить текущие уведомления банка", () -> BankListener.inspectCurrent(this));
    action("Отправить очередь / проверить связь", () -> check());
    pause =
        action(
            "Пауза",
            () -> {
              Vault.prefs(this).edit().putBoolean("enabled", !Vault.active(this)).apply();
              if (Vault.active(this)) {
                NotificationListenerService.requestRebind(
                    new ComponentName(this, BankListener.class));
                Sender.schedule(this);
              } else cancelBankJobs();
              renderStatus();
            });
    action(
        "Открыть Плутос",
        () -> {
          try {
            JSONObject c = Vault.config(this);
            if (c != null)
              startActivity(
                  new Intent(
                      Intent.ACTION_VIEW,
                      android.net.Uri.parse(c.getString("origin") + "/modules/balance/")));
            else message("Сначала подключи хаб");
          } catch (Exception e) {
            message("Не удалось открыть хаб");
          }
        });
    layout = bankOptions;
    action(
        "Очистить очередь",
        () ->
            new AlertDialog.Builder(this)
                .setTitle("Очистить очередь?")
                .setMessage("Неотправленные операции будут потеряны. Записи в хабе останутся.")
                .setNegativeButton("Отмена", null)
                .setPositiveButton(
                    "Очистить",
                    (d, w) -> {
                      if (Sender.sending.get()) {
                        message("Дождись окончания отправки");
                        return;
                      }
                      try (Queue q = new Queue(this)) {
                        q.clear();
                        renderStatus();
                      }
                    })
                .show());
    action(
        "Отключить банк",
        () ->
            new AlertDialog.Builder(this)
                .setTitle("Отключить банк?")
                .setMessage(
                    "Ключ и очередь будут удалены с телефона. Отозвать сам ключ можно в настройках"
                        + " Плутоса.")
                .setNegativeButton("Отмена", null)
                .setPositiveButton("Отключить", (d, w) -> disconnect())
                .show());
    layout = bankOptions;
    label(
        "Ключ: настройки Плутоса → источник банка. Для SMS выбери отправителя. Коды входа не"
            + " передаются.",
        12,
        0xff9ba8b9);
    layout = root;
    try {
      JSONObject c = Vault.config(this);
      if (c != null) {
        origin.setText(c.getString("origin"));
        bank = c.getString("package");
        bankLabel.setText(bank);
        token.setHint("Ключ сохранён · оставь пустым");
      }
    } catch (Exception e) {
      Vault.status(this, "Нужно подключить источник заново");
    }
  }

  protected void onStart() {
    super.onStart();
    Vault.prefs(this).registerOnSharedPreferenceChangeListener(changes);
    Sender.schedule(this);
  }

  protected void onStop() {
    Vault.prefs(this).unregisterOnSharedPreferenceChangeListener(changes);
    super.onStop();
  }

  protected void onResume() {
    super.onResume();
    renderStatus();
  }

  TextView label(String text, int sp, int color) {
    TextView n = new TextView(this);
    n.setText(text);
    n.setTextSize(sp);
    n.setTextColor(color);
    n.setPadding(0, dp(8), 0, dp(8));
    layout.addView(n);
    return n;
  }

  EditText field(String hint, boolean secret) {
    EditText n = new EditText(this);
    n.setTextSize(14);
    n.setPadding(dp(10), dp(9), dp(10), dp(9));
    n.setBackground(surface(0x30131e2d));
    n.setSingleLine(true);
    n.setHint(hint);
    n.setTextColor(Color.WHITE);
    n.setHintTextColor(0xff8e9bac);
    n.setInputType(
        secret
            ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
            : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    n.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.setMargins(0, dp(4), 0, dp(4));
    layout.addView(n, p);
    return n;
  }

  Button action(String title, Runnable fn) {
    Button n = new Button(this);
    n.setText(title);
    n.setAllCaps(false);
    n.setTextSize(13);
    n.setMinHeight(0);
    n.setMinimumHeight(0);
    n.setPadding(dp(10), dp(8), dp(10), dp(8));
    n.setTextColor(0xffd5dde8);
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(0x121b2c42);
    bg.setStroke(dp(1), 0xff3c4654);
    bg.setCornerRadius(dp(8));
    n.setBackground(bg);
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.setMargins(0, dp(6), 0, dp(2));
    layout.addView(n, p);
    n.setOnClickListener(
        v -> {
          if (!working) fn.run();
        });
    return n;
  }

  void message(String text) {
    Vault.status(this, text);
    renderStatus();
  }

  void renderStatus() {
    if (status == null) return;
    try (Queue q = new Queue(this)) {
      String granted =
          Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
      boolean permission = false;
      if (granted != null)
        for (String part : granted.split(":"))
          if (new ComponentName(this, BankListener.class)
              .equals(ComponentName.unflattenFromString(part))) permission = true;
      String last =
          Vault.prefs(this).getLong("last", 0) == 0
              ? "ещё не было"
              : java.text.DateFormat.getDateTimeInstance()
                  .format(new java.util.Date(Vault.prefs(this).getLong("last", 0)));
      bankSummary.setText(
          (Vault.active(this) ? "Приём включён" : "Приём на паузе")
              + " · "
              + (BankSms.enabled(this) ? "SMS" : "пуши")
              + "\nОжидают: "
              + q.count("pending")
              + " · Отклонены: "
              + q.count("blocked")
              + "\n"
              + Vault.prefs(this).getString("status", "Подключи банк в настройках"));
      status.setText(
          (Vault.active(this) ? "Приём включён" : "Приём на паузе")
              + "\nКанал: "
              + (BankSms.enabled(this) ? "SMS" : "пуши")
              + "\nРазрешение SMS: "
              + (checkSelfPermission(android.Manifest.permission.RECEIVE_SMS)
                      == android.content.pm.PackageManager.PERMISSION_GRANTED
                  ? "есть"
                  : "нет")
              + " · SMS банка: "
              + Vault.prefs(this).getLong("smsEvents", 0)
              + "\nДоступ к уведомлениям: "
              + (permission ? "разрешён" : "не разрешён")
              + "\nСлушатель Android: "
              + (BankListener.connected() ? "подключён" : "НЕ подключён")
              + "\nУведомления банка: "
              + Vault.prefs(this).getLong("bankEvents", 0)
              + "\nОбработка: "
              + Vault.prefs(this).getString("capture", "уведомления банка ещё не получены")
              + "\nОжидают: "
              + q.count("pending")
              + " · Отклонены: "
              + q.count("blocked")
              + "\nПропущено / не распознано: "
              + Vault.prefs(this).getLong("skipped", 0)
              + "\nПоследняя доставка: "
              + last
              + "\n"
              + Vault.prefs(this).getString("status", ""));
      pause.setText(Vault.active(this) ? "Приостановить приём" : "Возобновить приём");
    } catch (Exception e) {
      status.setText("Не удалось открыть очередь");
    }
  }

  GradientDrawable surface(int color) {
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(color);
    bg.setStroke(dp(1), 0x557f94ac);
    bg.setCornerRadius(dp(8));
    return bg;
  }

  LinearLayout card(LinearLayout parent) {
    LinearLayout panel = new LinearLayout(this);
    panel.setOrientation(LinearLayout.VERTICAL);
    panel.setPadding(dp(12), dp(10), dp(12), dp(12));
    panel.setBackground(surface(0x55131c29));
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.setMargins(0, dp(8), 0, dp(4));
    parent.addView(panel, p);
    return panel;
  }

  void cancelBankJobs() {
    JobScheduler jobs = (JobScheduler) getSystemService(JOB_SCHEDULER_SERVICE);
    jobs.cancel(1);
    jobs.cancel(2);
  }

  void bandPanel() {
    LinearLayout root = layout;
    layout = card(root);
    label("АСКЛЕПИЙ / браслет", 15, 0xffd5dde8);
    action(
        "Band 11 · подключение и данные",
        () -> startActivity(new Intent(this, BandActivity.class)));
    layout = root;
  }

  void smsSettings() {
    if (Sender.sending.get()) {
      message("Дождись окончания отправки");
      return;
    }
    try (Queue q = new Queue(this)) {
      if (q.count("pending") + q.count("blocked") > 0) {
        message("Перед сменой канала отправь или разбери очередь");
        return;
      }
    }
    new AlertDialog.Builder(this)
        .setTitle("Канал операций")
        .setItems(
            new String[] {"Пуши банка", "Новые SMS банка"},
            (d, index) -> {
              if (index == 0) {
                synchronized (Vault.class) {
                  try (Queue q = new Queue(this)) {
                    if (Sender.sending.get() || q.count("pending") + q.count("blocked") > 0) {
                      message("Сначала разбери очередь");
                      return;
                    }
                  }
                  Vault.prefs(this).edit().putBoolean("sms", false).apply();
                }
                message("Выбраны пуши банка");
                return;
              }
              EditText senders = new EditText(this);
              senders.setSingleLine(true);
              senders.setText(Vault.prefs(this).getString("smsSenders", "900"));
              new AlertDialog.Builder(this)
                  .setTitle("Отправители SMS")
                  .setMessage(
                      "Точные номера или имена через запятую. Для Сбера обычно 900 — сверь с"
                          + " сообщениями. Новые покупки записываются автоматически; пуши банка в"
                          + " этом режиме отключены. История SMS не читается.")
                  .setView(senders)
                  .setNegativeButton("Отмена", null)
                  .setPositiveButton(
                      "Включить",
                      (dialog, w) -> {
                        String list = senders.getText().toString().trim();
                        if (!list.matches(
                            "[+A-Za-z0-9_-]{1,32}( *[,] *[+A-Za-z0-9_-]{1,32}){0,9}")) {
                          message("Укажи до 10 точных отправителей через запятую");
                          return;
                        }
                        Vault.prefs(this).edit().putString("smsSenders", list).apply();
                        checkSmsServer();
                      })
                  .show();
            })
        .setNegativeButton("Отмена", null)
        .show();
  }

  void checkSmsServer() {
    working = true;
    new Thread(
            () -> {
              boolean supported = false;
              try {
                JSONObject c = Vault.config(this);
                if (c != null) {
                  HubHttp.Result r = Sender.post(c, new JSONObject().put("type", "hello"));
                  supported = r.code == 200 && r.body.optBoolean("sms", false);
                }
              } catch (Exception e) {
              }
              final boolean ok = supported;
              runOnUiThread(
                  () -> {
                    working = false;
                    if (!ok) {
                      message("Сначала обнови хаб до 0.35.40, подключи источник и проверь связь");
                      return;
                    }
                    if (checkSelfPermission(android.Manifest.permission.RECEIVE_SMS)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED)
                      requestPermissions(
                          new String[] {android.Manifest.permission.RECEIVE_SMS}, 41);
                    else activateSms();
                  });
            },
            "hecate-sms-check")
        .start();
  }

  void activateSms() {
    synchronized (Vault.class) {
      try (Queue q = new Queue(this)) {
        if (Sender.sending.get() || q.count("pending") + q.count("blocked") > 0) {
          message("Перед сменой канала дождись отправки очереди");
          return;
        }
      }
      Vault.prefs(this).edit().putBoolean("sms", true).apply();
      message(
          "SMS включены. Ожидается новое сообщение разрешённого отправителя; пуши банка"
              + " отключены.");
    }
  }

  public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(request, permissions, results);
    if (request == 41) {
      if (checkSelfPermission(android.Manifest.permission.RECEIVE_SMS)
          == android.content.pm.PackageManager.PERMISSION_GRANTED) activateSms();
      else
        message(
            "Android не разрешил приём SMS. Проверь разрешения приложения; установщик может"
                + " ограничивать этот доступ. Пуши остаются доступны.");
    }
  }

  void chooseBank() {
    List<ResolveInfo> apps =
        new ArrayList<>(
            getPackageManager()
                .queryIntentActivities(
                    new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0));
    apps.sort(Comparator.comparing(a -> a.loadLabel(getPackageManager()).toString()));
    String[] names = new String[apps.size()];
    for (int i = 0; i < names.length; i++)
      names[i] =
          apps.get(i).loadLabel(getPackageManager()) + "\n" + apps.get(i).activityInfo.packageName;
    new AlertDialog.Builder(this)
        .setTitle("Приложение банка")
        .setItems(
            names,
            (d, which) -> {
              bank = apps.get(which).activityInfo.packageName;
              bankLabel.setText(names[which]);
            })
        .setNegativeButton("Отмена", null)
        .show();
  }

  void connect() {
    if (Sender.sending.get()) {
      message("Дождись окончания отправки");
      return;
    }
    try {
      URI uri = new URI(origin.getText().toString().trim());
      if (!"https".equals(uri.getScheme())
          || uri.getHost() == null
          || uri.getUserInfo() != null
          || uri.getQuery() != null
          || uri.getFragment() != null
          || !(uri.getPath().isEmpty() || uri.getPath().equals("/"))) throw new Exception();
      String url = uri.toString().replaceAll("/$", ""),
          key = token.getText().toString().trim().replaceFirst("^Bearer ", "");
      JSONObject old = Vault.config(this);
      if (key.isEmpty()
          && old != null
          && url.equals(old.getString("origin"))
          && bank.equals(old.getString("package"))) key = old.getString("token");
      if (!key.matches("[A-Za-z0-9_-]{43}") || bank.isEmpty()) {
        message("Укажи адрес, выбери банк и вставь ключ источника");
        return;
      }
      JSONObject config =
          new JSONObject().put("origin", url).put("token", key).put("package", bank);
      try (Queue q = new Queue(this)) {
        if (old != null
            && !old.toString().equals(config.toString())
            && (q.count("pending") + q.count("blocked") > 0)) {
          new AlertDialog.Builder(this)
              .setTitle("Изменить подключение?")
              .setMessage("Старая очередь будет удалена, чтобы не отправить её в другой источник.")
              .setNegativeButton("Отмена", null)
              .setPositiveButton("Изменить", (d, w) -> verify(config, true))
              .show();
          return;
        }
      }
      verify(config, true);
    } catch (Exception e) {
      message("Проверь HTTPS-адрес хаба и ключ. Адрес нужен без пути.");
    }
  }

  void verify(JSONObject config, boolean save) {
    working = true;
    connect.setEnabled(false);
    message("Проверка соединения…");
    new Thread(
            () -> {
              String error = null;
              try {
                HubHttp.Result result = Sender.post(config, new JSONObject().put("type", "hello"));
                if (result.code != 200 || !"ready".equals(result.body.optString("state")))
                  throw new Exception(
                      "Хаб не подтвердил подключение (HTTP "
                          + result.code
                          + "). Обнови хаб и проверь ключ.");
                if (!config.getString("package").equals(result.body.getString("package")))
                  throw new Exception(
                      "Выбранный банк не совпадает с приложением в настройках источника.");
                if (save) {
                  synchronized (Vault.class) {
                    JSONObject old = Vault.config(this);
                    if (old != null && !old.toString().equals(config.toString()))
                      try (Queue q = new Queue(this)) {
                        q.clear();
                        Vault.prefs(this)
                            .edit()
                            .putBoolean("sms", false)
                            .remove("last")
                            .putLong("skipped", 0)
                            .apply();
                      }
                    if (!Vault.prefs(this)
                        .edit()
                        .putString("connection", Vault.seal(config.toString()))
                        .putBoolean("enabled", true)
                        .commit()) throw new Exception("Не удалось сохранить подключение");
                  }
                }
                Vault.status(
                    this,
                    "Хаб доступен. Разреши доступ к уведомлениям и проверь реальную покупку.");
                Sender.schedule(this);
              } catch (Exception e) {
                error =
                    e.getMessage() != null && e.getMessage().startsWith("Хаб")
                        ? e.getMessage()
                        : "Подключение не подтверждено: проверь банк, ключ, адрес и сеть.";
              }
              final String result = error;
              runOnUiThread(
                  () -> {
                    working = false;
                    connect.setEnabled(true);
                    if (result != null) message(result);
                    else {
                      token.setText("");
                      token.setHint("Ключ сохранён · оставь пустым");
                      renderStatus();
                    }
                  });
            },
            "hecate-connect")
        .start();
  }

  void check() {
    try {
      JSONObject c = Vault.config(this);
      if (c == null) {
        message("Сначала подключи хаб");
        return;
      }
      verify(c, false);
    } catch (Exception e) {
      message("Подключи источник заново");
    }
  }

  void disconnect() {
    synchronized (Vault.class) {
      if (Sender.sending.get()) {
        message("Дождись окончания отправки");
        return;
      }
      Vault.prefs(this)
          .edit()
          .putBoolean("enabled", false)
          .remove("connection")
          .putBoolean("sms", false)
          .commit();
      cancelBankJobs();
      try (Queue q = new Queue(this)) {
        q.clear();
      }
      token.setText("");
      message("Банк отключён");
    }
  }
}
