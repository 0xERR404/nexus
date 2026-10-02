package xyz.nexus404.hecate;

import android.app.*;
import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.*;
import android.widget.*;
import java.util.*;
import org.json.*;

public final class BandActivity extends Activity {
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Set<String> seen = new HashSet<>();
  private BluetoothLeScanner scanner;
  private BluetoothDevice pendingDevice;
  private LinearLayout layout, devices;
  private TextView status, feedback, bridgeStatus;
  private boolean scanning, connectingServer, rebindRequested, pendingRenew, connectionStarting;
  private TextView uploadStatus, connectionStatus;
  private EditText hubOrigin, hubKey;
  private HubHttp.Call uploadCall;
  private final StringBuilder report = new StringBuilder();
  private final Runnable stopScan =
      () -> {
        stopScan();
        note(
            seen.isEmpty()
                ? "Band 11 не найден. Включи экран браслета и проверь, что Huawei Health не"
                    + " удерживает соединение."
                : "Поиск завершён. Выбери свой браслет.");
      };

  int dp(int n) {
    return Math.round(n * getResources().getDisplayMetrics().density);
  }

  public void onCreate(Bundle state) {
    super.onCreate(state);
    if (state != null) {
      rebindRequested = state.getBoolean("bandRenew");
      pendingRenew = state.getBoolean("bandPendingRenew");
      pendingDevice = state.getParcelable("bandPendingDevice");
    }
    ScrollView scroll = new ScrollView(this);
    scroll.setFitsSystemWindows(true);
    scroll.setBackground(new HubBackground());
    layout = new LinearLayout(this);
    layout.setOrientation(1);
    layout.setPadding(dp(14), dp(12), dp(14), dp(24));
    scroll.addView(layout);
    setContentView(scroll);
    text("АСКЛЕПИЙ / BAND 11", 19).setTypeface(Typeface.MONOSPACE);
    text("Связь, уведомления и музыка телефона", 13);
    serverSettings();
    connectionStatus = text("", 13);
    feedback = text("", 12);
    button(layout, "Подключить", this::connectSaved);
    button(
        layout,
        "Прочитать сейчас",
        () -> {
          try {
            if (BandService.enabled(this))
              startForegroundService(new Intent(this, BandService.class).setAction("read"));
            else note("Сначала подключи браслет");
          } catch (RuntimeException e) {
            note("Android не разрешил запуск связи");
          }
        });
    devices = new LinearLayout(this);
    devices.setOrientation(1);
    layout.addView(devices);
    status = text("Подключи хаб и выбери браслет.", 13);
    status.setTextIsSelectable(true);
    status.setVisibility(android.view.View.GONE);
    button(
        layout,
        "Диагностика",
        () ->
            status.setVisibility(
                status.getVisibility() == android.view.View.GONE
                    ? android.view.View.VISIBLE
                    : android.view.View.GONE));
    button(
        layout,
        "Скопировать журнал",
        () -> {
          if (report.length() == 0) {
            note("Сначала выполни проверку.");
            return;
          }
          ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE))
              .setPrimaryClip(ClipData.newPlainText("Band 11", report.toString()));
          Toast.makeText(this, "Диагностика скопирована", Toast.LENGTH_SHORT).show();
        });
    button(
        layout,
        "Остановить связь",
        () -> {
          connectionStarting = false;
          stopScan();
          BandService.stop(this);
          note("Остановлено");
        });
  }

  boolean allowed() {
    if (Build.VERSION.SDK_INT >= 31)
      return checkSelfPermission("android.permission.BLUETOOTH_SCAN")
              == PackageManager.PERMISSION_GRANTED
          && checkSelfPermission("android.permission.BLUETOOTH_CONNECT")
              == PackageManager.PERMISSION_GRANTED;
    return checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")
        == PackageManager.PERMISSION_GRANTED;
  }

  void connectSaved() {
    if (!allowed()) {
      requestPermissions(
          Build.VERSION.SDK_INT >= 31
              ? new String[] {
                "android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"
              }
              : new String[] {"android.permission.ACCESS_FINE_LOCATION"},
          91);
      return;
    }
    if (BandService.enabled(this)) {
      BandService.resume(this);
      note("Связь уже включена");
      return;
    }
    connectionStarting = false;
    try {
      String saved = Vault.prefs(this).getString("bandDevice", "");
      if (!saved.isEmpty()) {
        BluetoothAdapter adapter =
            ((BluetoothManager) getSystemService(BLUETOOTH_SERVICE)).getAdapter();
        if (adapter != null && adapter.isEnabled()) {
          connect(adapter.getRemoteDevice(Vault.open(saved)), false);
          return;
        }
      }
    } catch (Exception ignored) {
    }
    scan(false);
  }

  void scan() {
    scan(false);
  }

  void scan(boolean renew) {
    rebindRequested = renew;
    connectionStarting = false;
    if (connectingServer) {
      note("Дождись проверки подключения хаба");
      return;
    }
    try {
      if (BandUpload.config(this) == null) {
        note("Сначала укажи адрес и ключ Асклепия в настройках подключения");
        return;
      }
    } catch (Exception e) {
      note("Не удалось прочитать подключение хаба");
      return;
    }
    if (!allowed()) {
      requestPermissions(
          Build.VERSION.SDK_INT >= 31
              ? new String[] {
                "android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"
              }
              : new String[] {"android.permission.ACCESS_FINE_LOCATION"},
          91);
      return;
    }
    stopScan();
    BandService.stop(this);
    report.setLength(0);
    report
        .append("Геката ")
        .append(Vault.version(this))
        .append(" · Band 11 · Android ")
        .append(Build.VERSION.RELEASE)
        .append('\n');
    seen.clear();
    devices.removeAllViews();
    try {
      BluetoothManager manager = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
      BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
      if (adapter == null || !adapter.isEnabled()) {
        note("Включи Bluetooth в настройках телефона и повтори поиск.");
        return;
      }
      if (Build.VERSION.SDK_INT < 31
          && !((android.location.LocationManager) getSystemService(LOCATION_SERVICE))
              .isProviderEnabled(android.location.LocationManager.GPS_PROVIDER)) {
        note("На Android 8–11 для BLE-поиска может потребоваться включить геолокацию.");
      }
      scanner = adapter.getBluetoothLeScanner();
      if (scanner == null) {
        note("Сканер Bluetooth недоступен");
        return;
      }
      scanning = true;
      scanner.startScan(
          Collections.emptyList(),
          new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
          scanCallback);
      note("Поиск Band 11 · до 15 секунд…");
      main.postDelayed(stopScan, 15000);
    } catch (RuntimeException e) {
      stopScan();
      note("Не удалось начать поиск · " + e.getClass().getSimpleName());
    }
  }

  final ScanCallback scanCallback =
      new ScanCallback() {
        public void onScanResult(int type, ScanResult result) {
          main.post(
              () -> {
                if (!scanning) return;
                try {
                  BluetoothDevice d = result.getDevice();
                  String n =
                      result.getScanRecord() == null
                          ? null
                          : result.getScanRecord().getDeviceName();
                  if (n == null) n = d.getName();
                  if (n == null || !n.toLowerCase(Locale.ROOT).matches("huawei band 11(?:-.*)?"))
                    return;
                  if (seen.size() >= 12 || !seen.add(d.getAddress())) return;
                  String label = n.replaceAll("[\\p{Cntrl}]", "");
                  final boolean renew = rebindRequested;
                  button(
                      devices,
                      label
                          + " · "
                          + result.getRssi()
                          + " dBm"
                          + (renew ? " · восстановление" : ""),
                      () -> connect(d, renew));
                } catch (SecurityException e) {
                  stopScan();
                  note("Разрешение Bluetooth отозвано");
                }
              });
        }

        public void onScanFailed(int code) {
          main.post(
              () -> {
                stopScan();
                note("Ошибка сканирования: " + code + ". Повтори поиск позже.");
              });
        }
      };

  void stopScan() {
    main.removeCallbacks(stopScan);
    scanning = false;
    if (scanner != null) {
      try {
        scanner.stopScan(scanCallback);
      } catch (RuntimeException ignored) {
      }
      scanner = null;
    }
  }

  void connect(BluetoothDevice device, boolean renew) {
    if (connectionStarting || pendingDevice != null) return;
    stopScan();
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
            != PackageManager.PERMISSION_GRANTED
        && !Vault.prefs(this).getBoolean("bandNoticeAsked", false)) {
      pendingDevice = device;
      pendingRenew = renew;
      Vault.prefs(this).edit().putBoolean("bandNoticeAsked", true).apply();
      requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 92);
      return;
    }
    try {
      startForegroundService(
          new Intent(this, BandService.class)
              .setAction("connect")
              .putExtra("address", device.getAddress())
              .putExtra("renew", renew));
      connectionStarting = true;
      devices.removeAllViews();
      rebindRequested = false;
      note(
          renew
              ? "Запущено восстановление сопряжения · ожидаем ответ браслета"
              : "Запущен вход с сохранённым ключом");
    } catch (RuntimeException e) {
      note("Android не разрешил запуск · проверь разрешение Bluetooth");
    }
  }

  void serverSettings() {
    LinearLayout settings = new LinearLayout(this);
    settings.setOrientation(1);
    settings.setVisibility(android.view.View.GONE);
    button(
        layout,
        "Настройки подключения к Асклепию",
        () ->
            settings.setVisibility(
                settings.getVisibility() == android.view.View.GONE
                    ? android.view.View.VISIBLE
                    : android.view.View.GONE));
    layout.addView(settings);
    button(
        settings,
        "Фоновая работа · настройки Android",
        () -> {
          try {
            startActivity(
                new Intent(
                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:" + getPackageName())));
          } catch (RuntimeException e) {
            note("Открой настройки Android → Приложения → Геката → Батарея");
          }
        });
    button(settings, "Выбрать другой браслет", this::scan);
    button(
        settings,
        "Открыть Bluetooth Android",
        () -> {
          try {
            startActivity(new Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS));
          } catch (RuntimeException e) {
            note("Открой Bluetooth в настройках телефона");
          }
        });
    BandMedia.settings(this, settings);
    BandNotices.settings(this, settings);
    bridgeStatus = new TextView(this);
    bridgeStatus.setTextColor(0xffa9b8c9);
    bridgeStatus.setTextSize(12);
    settings.addView(bridgeStatus);
    hubOrigin = new EditText(this);
    hubOrigin.setHint("https://твой-хаб");
    hubOrigin.setSingleLine(true);
    hubOrigin.setTextColor(0xffd5dde8);
    hubOrigin.setTextSize(13);
    settings.addView(hubOrigin);
    hubKey = new EditText(this);
    hubKey.setHint("Ключ источника Асклепия");
    hubKey.setSingleLine(true);
    hubKey.setInputType(129);
    hubKey.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO);
    hubKey.setTextColor(0xffd5dde8);
    hubKey.setTextSize(13);
    settings.addView(hubKey);
    button(
        settings,
        "Проверить и сохранить",
        () -> {
          if (BandService.enabled(this) || connectingServer) {
            note("Заверши чтение перед изменением подключения");
            return;
          }
          try {
            String origin = hubOrigin.getText().toString().trim().replaceAll("/+$", ""),
                key = hubKey.getText().toString().trim();
            JSONObject old = BandUpload.config(this);
            if (key.isEmpty() && old != null && origin.equals(old.getString("origin")))
              key = old.getString("token");
            java.net.URI u = new java.net.URI(origin);
            if (!"https".equals(u.getScheme())
                || u.getHost() == null
                || u.getUserInfo() != null
                || u.getQuery() != null
                || u.getFragment() != null
                || !u.getPath().isEmpty()
                || !key.matches("[A-Za-z0-9_-]{43}")) throw new Exception();
            JSONObject cfg = new JSONObject().put("origin", origin).put("token", key);
            if (uploadCall != null) uploadCall.cancel();
            uploadCall = new HubHttp.Call();
            HubHttp.Call task = uploadCall;
            connectingServer = true;
            new Thread(
                    () -> {
                      try {
                        JSONObject answer = task.send(cfg, new JSONObject().put("type", "hello"));
                        if (!"ready".equals(answer.optString("state"))
                            || !"json".equals(answer.optString("format"))) throw new Exception();
                        if (!answer.optBoolean("bandSnapshot"))
                          throw new java.io.IOException("Сначала обнови хаб до 0.35.59 или новее");
                        if (task.stopped) return;
                        cfg.put("bandExtended", answer.optBoolean("bandExtended"))
                            .put("bandMetrics", answer.optBoolean("bandMetrics"));
                        BandUpload.saveConfig(this, cfg);
                        main.post(
                            () -> {
                              hubKey.setText("");
                              hubKey.setHint("Ключ сохранён");
                              note("Асклепий подключён. Теперь можно читать браслет.");
                            });
                        BandUpload.schedule(this, true);
                      } catch (Exception e) {
                        main.post(
                            () ->
                                note(
                                    e instanceof java.io.IOException
                                        ? e.getMessage()
                                        : "Не удалось подключить хаб; проверь ключ и адрес"));
                      } finally {
                        main.post(() -> connectingServer = false);
                      }
                    },
                    "band-config")
                .start();
          } catch (Exception e) {
            note("Нужны HTTPS-адрес хаба без пути и ключ источника");
          }
        });
    button(
        settings,
        "Восстановить сопряжение",
        () -> {
          if (BandService.enabled(this)) {
            note("Сначала нажми «Остановить», затем восстановление");
            return;
          }
          scan(true);
        });
    button(
        settings,
        "Удалить неотправленную очередь",
        () -> {
          if (BandService.enabled(this)) {
            note("Сначала останови чтение");
            return;
          }
          LinearLayout confirm = new LinearLayout(this);
          confirm.setOrientation(1);
          settings.addView(confirm);
          button(
              confirm,
              "Подтверждаю удаление данных только из очереди",
              () -> {
                try {
                  if (BandService.enabled(this))
                    throw new java.io.IOException("Сначала останови чтение");
                  BandUpload.clear(this);
                  settings.removeView(confirm);
                  refreshUpload();
                } catch (Exception e) {
                  note(e.getMessage());
                }
              });
          button(confirm, "Отмена", () -> settings.removeView(confirm));
        });
    button(
        settings,
        "Повторить отправку данных",
        () -> {
          BandUpload.schedule(this, true);
          refreshUpload();
        });
    uploadStatus = text("", 12);
    try {
      JSONObject cfg = BandUpload.config(this);
      if (cfg != null) {
        hubOrigin.setText(cfg.getString("origin"));
        hubKey.setHint("Ключ сохранён");
      } else settings.setVisibility(android.view.View.VISIBLE);
    } catch (Exception ignored) {
    }
    refreshUpload();
  }

  void refreshUpload() {
    if (bridgeStatus != null)
      bridgeStatus.setText(
          Vault.prefs(this).getString("bandMediaStatus", "")
              + "\n"
              + Vault.prefs(this).getString(BandNotices.STATUS, "")
              + "\n"
              + Vault.prefs(this).getString("bandFilesStatus", ""));
    if (connectionStatus != null) {
      long last = Vault.prefs(this).getLong("bandReadAt", 0);
      String value =
          BandService.enabled(this) && BandService.instance == null
              ? "Служба не работает · нажми «Прочитать сейчас»"
              : Vault.prefs(this).getString("bandState", "Связь не запущена");
      connectionStatus.setText(
          value
              + (last > 0
                  ? "\nОбновлено: "
                      + java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT)
                          .format(new Date(last))
                  : ""));
    }
    if (status != null) {
      String saved = Vault.prefs(this).getString("bandReport", "");
      if (!saved.isEmpty()) {
        report.setLength(0);
        report.append(saved);
        status.setText(saved);
      }
    }
    if (uploadStatus != null)
      uploadStatus.setText(Vault.prefs(this).getString("bandUploadStatus", "Очередь пуста"));
  }

  private final Runnable render = this::refreshUpload;
  private final android.content.SharedPreferences.OnSharedPreferenceChangeListener uploadChanged =
      (p, key) -> {
        if (key != null && key.startsWith("band")) {
          main.removeCallbacks(render);
          main.postDelayed(render, 250);
        }
      };

  protected void onStart() {
    super.onStart();
    if (BandService.instance != null) BandService.instance.refreshMediaBridge();
    Vault.prefs(this).registerOnSharedPreferenceChangeListener(uploadChanged);
    BandUpload.schedule(this, false);
    if (BandService.instance != null)
      BandService.instance.note("Открыт экран Асклепия · " + BandService.powerState(this));
    refreshUpload();
  }

  void note(String s) {
    if (feedback != null) feedback.setText(s);
    report.append(s).append('\n');
    if (status != null) status.setText(report.toString());
  }

  public void onRequestPermissionsResult(int code, String[] p, int[] r) {
    super.onRequestPermissionsResult(code, p, r);
    if (code == 92 && pendingDevice != null) {
      BluetoothDevice device = pendingDevice;
      boolean renew = pendingRenew;
      pendingDevice = null;
      pendingRenew = false;
      connect(device, renew);
    }
    if (code == 91) {
      if (allowed()) {
        if (rebindRequested) scan(true);
        else connectSaved();
      } else note("Разреши устройства поблизости в настройках Гекаты");
    }
  }

  protected void onSaveInstanceState(Bundle out) {
    out.putBoolean("bandRenew", rebindRequested);
    out.putBoolean("bandPendingRenew", pendingRenew);
    out.putParcelable("bandPendingDevice", pendingDevice);
    super.onSaveInstanceState(out);
  }

  protected void onStop() {
    Vault.prefs(this).unregisterOnSharedPreferenceChangeListener(uploadChanged);
    if (uploadCall != null) uploadCall.cancel();
    stopScan();
    super.onStop();
  }

  protected void onDestroy() {
    stopScan();
    main.removeCallbacksAndMessages(null);
    super.onDestroy();
  }

  TextView text(String s, int size) {
    TextView t = new TextView(this);
    t.setText(s);
    t.setTextSize(size);
    t.setTextColor(0xffd5dde8);
    t.setPadding(0, dp(7), 0, dp(7));
    layout.addView(t);
    return t;
  }

  void button(LinearLayout parent, String title, Runnable action) {
    Button b = new Button(this);
    b.setText(title);
    b.setTextSize(13);
    b.setTextColor(0xffd5dde8);
    b.setAllCaps(false);
    b.setMinimumHeight(dp(44));
    b.setMinHeight(dp(44));
    b.setPadding(dp(10), dp(6), dp(10), dp(6));
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(0x28131c29);
    bg.setStroke(dp(1), 0x557f94ac);
    bg.setCornerRadius(dp(8));
    b.setBackground(bg);
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.setMargins(0, dp(4), 0, dp(4));
    parent.addView(b, p);
    b.setOnClickListener(v -> action.run());
  }
}
