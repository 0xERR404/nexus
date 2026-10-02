package xyz.nexus404.hecate;

import android.app.*;
import android.bluetooth.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

public final class BandService extends Service {
  // State and GATT writes belong to the main thread; worker only persists the outbox.
  private static final int BOOTSTRAP = 0;
  private static final int AUTHENTICATION = 2;
  private static final int READING_BATTERY = 3;
  private static final int READING_SNAPSHOT = 4;
  private static final int READING_HISTORY = 5;
  private static final int CONFIGURING = 6;
  private static final int SENDING_NOTICE = 7;
  private static final int SENDING_MEDIA = 8;
  private static final int IDLE = 9;
  private static final int READING_FILES = 10;

  static volatile BandService instance;
  static final int NOTICE = 71;
  static final String CHANNEL = "band-connection";
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private BluetoothGatt gatt;
  private BluetoothGattCharacteristic write;
  private BandProtocol protocol;
  private BandAuth auth;
  private BandHistory history;
  private Boolean pendingExtendedEvidence;
  private BandSetup setup;
  private BandFiles files;
  private long filesStarted;
  private boolean forceFiles, readingHistory, historyIncomplete;
  private boolean active, negotiating, writing, rebindSession, allowPair, configured, stopping;
  private volatile int generation,
      phase,
      pinMethod,
      lastBattery,
      sentChunks,
      totalChunks,
      failures,
      authFailures,
      setupFailures;
  private int remoteRetries;
  private boolean verifiedReading, sessionVerified;
  private long alarmDue;
  private final ArrayDeque<BandNotices.Item> notices = new ArrayDeque<>();
  private final LinkedHashMap<String, String> noticeSeen = new LinkedHashMap<>();
  private boolean noticeReady, noticeFailed;
  private int noticeStage, noticeId, noticeLimit = 15;
  private long mediaInfoAt;
  private final ArrayDeque<BandAuth.Request> mediaWrites = new ArrayDeque<>();
  private boolean mediaNoReply;
  private BandMedia.Watch mediaWatch;
  private byte[] mediaSignature;
  private final Runnable mediaUpdate = this::queueMediaInfo;
  private BluetoothDevice pendingBond;
  private boolean allowSystemBond, gattConnected;
  private final Runnable bondTimeout =
      () -> {
        if (pendingBond == null) return;
        try {
          if (pendingBond.getBondState() == BluetoothDevice.BOND_BONDED) {
            bondReady();
            return;
          }
        } catch (SecurityException ignored) {
        }
        pause(
            "Android не подтвердил сопряжение за 90 секунд. Ключ Huawei сохранён; автоматический"
                + " повтор сопряжения не запускается");
      };
  private byte[] identityBytes, sessionKey;
  private String keySlot, readTarget;
  private final ArrayDeque<byte[]> writes = new ArrayDeque<>();
  private Map<Integer, byte[]> waiting;
  private final StringBuilder report = new StringBuilder();
  private PowerManager.WakeLock wake;
  private final Runnable persist =
      () -> Vault.prefs(this).edit().putString("bandReport", report.toString()).apply();
  private final Runnable retry = this::attempt;
  private final Runnable poll = () -> tick("таймер службы");
  private final Runnable timeout =
      () ->
          finish(
              (totalChunks == 0
                      ? "Нет завершённого GATT-подключения или подписки"
                      : writing || !writes.isEmpty()
                          ? "Android подтвердил фрагменты: " + sentChunks + "/" + totalChunks
                          : "Нет ответа браслета после записи запроса")
                  + " · тайм-аут");

  static boolean enabled(Context c) {
    return Vault.prefs(c).getBoolean("bandEnabled", false);
  }

  static void stop(Context c) {
    Vault.prefs(c)
        .edit()
        .putBoolean("bandEnabled", false)
        .putString("bandState", "Остановлено")
        .apply();
    c.stopService(new Intent(c, BandService.class));
  }

  static void resume(Context c) {
    if (!enabled(c)) return;
    try {
      c.startForegroundService(new Intent(c, BandService.class).setAction("resume"));
    } catch (RuntimeException e) {
      Vault.prefs(c)
          .edit()
          .putString("bandState", "Android отложил запуск · открой Асклепий в Гекате")
          .apply();
    }
  }

  static boolean allowed(Context c) {
    return Build.VERSION.SDK_INT < 31
        || c.checkSelfPermission("android.permission.BLUETOOTH_CONNECT")
            == PackageManager.PERMISSION_GRANTED;
  }

  public IBinder onBind(Intent i) {
    return null;
  }

  public void onCreate() {
    super.onCreate();
    instance = this;
    mediaWatch =
        new BandMedia.Watch(
            this,
            main,
            () -> {
              main.removeCallbacks(mediaUpdate);
              main.postDelayed(mediaUpdate, 150);
            });
    NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    manager.createNotificationChannel(
        new NotificationChannel(
            CHANNEL, "Асклепий · связь с браслетом", NotificationManager.IMPORTANCE_LOW));
    wake =
        ((PowerManager) getSystemService(POWER_SERVICE))
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hecate:band");
    wake.setReferenceCounted(false);
    report
        .append("Геката ")
        .append(Vault.version(this))
        .append(" · Band 11 · Android ")
        .append(Build.VERSION.RELEASE)
        .append('\n');
    IntentFilter bluetoothEvents = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
    bluetoothEvents.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
    registerReceiver(bluetooth, bluetoothEvents);
  }

  Notification notification(String message) {
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            NOTICE,
            new Intent(this, BandActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop =
        PendingIntent.getBroadcast(
            this,
            NOTICE,
            new Intent(this, Control.class).setAction("stop"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
        .setContentTitle("Асклепий · Band 11")
        .setContentText(message)
        .setContentIntent(open)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .addAction(new Notification.Action.Builder(null, "Остановить", stop).build())
        .build();
  }

  public int onStartCommand(Intent i, int flags, int id) {
    try {
      if (!allowed(this)) {
        pause("Разреши Bluetooth в настройках Гекаты");
        return START_NOT_STICKY;
      }
      startForeground(NOTICE, notification("Связь с браслетом"));
      String action = i == null ? "resume" : i.getAction();
      note("Запуск службы · " + action + " · " + powerState(this));
      if ("connect".equals(action)) {
        String address = i.getStringExtra("address");
        if (address == null || !BluetoothAdapter.checkBluetoothAddress(address))
          throw new IllegalArgumentException();
        close();
        main.removeCallbacks(retry);
        cancelAlarm();
        if (!Vault.prefs(this)
            .edit()
            .putString("bandDevice", Vault.seal(address))
            .putBoolean("bandEnabled", true)
            .commit()) throw new java.io.IOException();
        rebindSession = i.getBooleanExtra("renew", false);
        note(
            rebindSession
                ? "Режим: восстановление сопряжения по запросу пользователя"
                : "Режим: обычное подключение");
        allowPair = true;
        allowSystemBond = true;
        failures = 0;
        authFailures = 0;
        setupFailures = 0;
        remoteRetries = 0;
        verifiedReading = false;
        attempt();
      } else if (!enabled(this)) {
        stopSelf();
        return START_NOT_STICKY;
      } else if ("read".equals(action)) {
        forceFiles = true;
        if (active && phase == IDLE) {
          cancelAlarm();
          startReading();
        } else if (!active) {
          main.removeCallbacks(retry);
          attempt();
        }
      } else if (!active) {
        main.removeCallbacks(retry);
        attempt();
      }
      return enabled(this) ? START_STICKY : START_NOT_STICKY;
    } catch (Exception e) {
      pause("Не удалось запустить связь с браслетом · " + e.getClass().getSimpleName());
      return START_NOT_STICKY;
    }
  }

  void attempt() {
    if (active || pendingBond != null || stopping || !enabled(this)) return;
    try {
      if (!allowed(this)) {
        pause("Разрешение Bluetooth отозвано");
        return;
      }
      BluetoothManager manager = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
      BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
      if (adapter == null) {
        pause("Bluetooth недоступен");
        return;
      }
      if (!adapter.isEnabled()) {
        state("Bluetooth выключен · ожидаем включения");
        return;
      }
      JSONObject cfg = BandUpload.config(this);
      if (cfg == null) {
        pause("Подключи хаб в настройках Асклепия");
        return;
      }
      readTarget = BandUpload.target(cfg);
      String address = Vault.open(Vault.prefs(this).getString("bandDevice", ""));
      configured = false;
      BluetoothDevice device = adapter.getRemoteDevice(address);
      int bond = device.getBondState();
      note("Системное сопряжение Android: " + bondLabel(bond));
      if (bond != BluetoothDevice.BOND_BONDED) {
        if (bond == BluetoothDevice.BOND_BONDING) {
          waitBond(device, false);
          return;
        }
        if (!allowSystemBond) {
          pause(
              "Нет системной пары Android. Нажми «Сопрячь и подключить Band 11» для подтверждения");
          return;
        }
        allowSystemBond = false;
        waitBond(device, true);
        return;
      }
      allowSystemBond = false;
      connect(device);
    } catch (Exception e) {
      pause("Не удалось прочитать подключение · открой настройки Асклепия");
    }
  }

  static String bondLabel(int state) {
    return state == BluetoothDevice.BOND_BONDED
        ? "сопряжено"
        : state == BluetoothDevice.BOND_BONDING ? "ожидается подтверждение" : "не сопряжено";
  }

  static String linkState(Context c) {
    String bond = "не выбрано";
    try {
      if (!allowed(c)) return "Bluetooth: нет разрешения";
      String sealed = Vault.prefs(c).getString("bandDevice", "");
      if (!sealed.isEmpty()) {
        BluetoothManager manager = (BluetoothManager) c.getSystemService(BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter != null)
          bond = bondLabel(adapter.getRemoteDevice(Vault.open(sealed)).getBondState());
      }
    } catch (Exception e) {
      bond = "состояние недоступно";
    }
    BandService s = instance;
    return "Пара Android: "
        + bond
        + "\nBluetooth: "
        + (s != null && s.gattConnected ? "подключён" : "не подключён")
        + "\nHuawei: "
        + (s != null && s.sessionVerified
            ? "защищённый обмен подтверждён"
            : "защищённый обмен не подтверждён");
  }

  void waitBond(BluetoothDevice device, boolean start) {
    pendingBond = device;
    hold();
    main.removeCallbacks(bondTimeout);
    main.postDelayed(bondTimeout, 90000);
    state("Сопряжение Android · подтверди запрос на телефоне и браслете");
    note(
        start
            ? "Запрос системного сопряжения Android · createBond"
            : "Android уже выполняет сопряжение; ожидаем результат");
    try {
      if (start && !device.createBond()) {
        pause(
            "Android не начал сопряжение. Поддержка системной пары браслетом не подтверждена; ключ"
                + " Huawei сохранён");
        return;
      }
      if (device.getBondState() == BluetoothDevice.BOND_BONDED) bondReady();
    } catch (SecurityException e) {
      pause("Нет разрешения Bluetooth для системного сопряжения");
    }
  }

  void bondReady() {
    if (pendingBond == null || stopping || !enabled(this)) return;
    pendingBond = null;
    main.removeCallbacks(bondTimeout);
    release();
    allowSystemBond = false;
    note("Android подтвердил BOND_BONDED · системная пара создана");
    state("Сопряжено с Android · подключаем браслет");
    main.post(retry);
  }

  void bondChanged(Intent intent) {
    try {
      BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
      if (device == null) return;
      String sealed = Vault.prefs(this).getString("bandDevice", "");
      if (sealed.isEmpty() || !device.getAddress().equals(Vault.open(sealed))) return;
      int value = device.getBondState();
      note("Событие сопряжения Android: " + bondLabel(value));
      if (pendingBond != null && pendingBond.getAddress().equals(device.getAddress())) {
        if (value == BluetoothDevice.BOND_BONDED) bondReady();
        else if (value == BluetoothDevice.BOND_NONE)
          pause("Сопряжение Android отменено или отклонено. Ключ Huawei и очередь сохранены");
      } else if (value == BluetoothDevice.BOND_NONE) {
        pause(
            "Системная пара удалена. Повторное сопряжение запускается только кнопкой пользователя");
      }
    } catch (Exception e) {
      pause("Не удалось проверить событие сопряжения Android");
    }
  }

  void hold() {
    if (wake != null) wake.acquire(90000);
  }

  void release() {
    if (wake != null && wake.isHeld()) wake.release();
  }

  void secure(BandAuth.Request next) throws Exception {
    request(
        new BandAuth.Request(
            next.service, next.command, BandAuth.encrypted(sessionKey, next.tlv), next.status));
  }

  void continueSetup(BandAuth.Request next) throws Exception {
    if (next == null) {
      configured = true;
      state("Последовательность настройки пройдена · проверка измерений");
      note("Настройка завершена; защищённый сеанс ещё требует GCM-проверки измерений");
      startReading();
    } else secure(next);
  }

  void startReading() throws Exception {
    historyIncomplete = false;
    phase = READING_BATTERY;
    state("Чтение измерений");
    secure(new BandAuth.Request(8, new byte[] {1, 0}, "Запрос заряда в защищённом сеансе"));
  }

  void completed() {
    if (BandPolicy.advanceHistory(readingHistory, history.finished, historyIncomplete) && history.metricsEnabled)
      Vault.prefs(this).edit().putBoolean(keySlot + ".metricsBackfill", true).apply();
    if (pendingExtendedEvidence != null) {
      BandEvidence.attempt(this, true, pendingExtendedEvidence);
      pendingExtendedEvidence = null;
    } else if (readingHistory) {
      BandEvidence.attempt(this, false, history.finished && !historyIncomplete);
      Vault.prefs(this).edit().putInt("bandUnknownSleep", history.unknownSleep).apply();
    }
    main.removeCallbacks(timeout);
    phase = IDLE;
    protocol.expect(-1, -1);
    failures = 0;
    authFailures = 0;
    setupFailures = 0;
    remoteRetries = 0;
    rebindSession = false;
    release();
    Vault.prefs(this)
        .edit()
        .putLong("bandReadAt", System.currentTimeMillis())
        .putLong(
            keySlot + ".readAt",
            BandPolicy.advanceHistory(readingHistory, history.finished, historyIncomplete) ? history.until : Vault.prefs(this).getLong(keySlot + ".readAt", 0))
        .apply();
    state("Подключён · данные обновляются автоматически");
    scheduleAlarm(BandPolicy.POLL);
    main.removeCallbacks(poll);
    main.postDelayed(poll, BandPolicy.POLL);
    BandUpload.schedule(this, true);
    refreshMediaBridge();
    if (!beginFiles()) pumpNotices();
  }

  PendingIntent alarm() {
    return PendingIntent.getBroadcast(
        this,
        NOTICE,
        new Intent(this, Control.class).setAction("tick"),
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  void scheduleAlarm(long delay) {
    alarmDue = SystemClock.elapsedRealtime() + delay;
    note(
        "Следующий запуск не раньше "
            + new java.text.SimpleDateFormat("HH:mm:ss", Locale.ROOT)
                .format(new Date(System.currentTimeMillis() + delay))
            + " · Android может отложить");
    ((AlarmManager) getSystemService(ALARM_SERVICE))
        .setAndAllowWhileIdle(
            AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + delay, alarm());
  }

  void cancelAlarm() {
    main.removeCallbacks(poll);
    ((AlarmManager) getSystemService(ALARM_SERVICE)).cancel(alarm());
  }

  void tick(String source) {
    if (!enabled(this) || stopping || active && phase != IDLE) return;
    note(
        source
            + " · задержка "
            + Math.max(0, (SystemClock.elapsedRealtime() - alarmDue) / 1000)
            + " с · "
            + powerState(this));
    try {
      if (active && phase == IDLE) {
        cancelAlarm();
        startReading();
      } else if (!active) {
        main.removeCallbacks(retry);
        attempt();
      }
    } catch (Exception e) {
      finish("Не удалось начать чтение");
    }
  }

  final BroadcastReceiver bluetooth =
      new BroadcastReceiver() {
        public void onReceive(Context c, Intent i) {
          if (!enabled(c)) return;
          if (BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(i.getAction())) {
            bondChanged(i);
            return;
          }
          int value = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1);
          if (value == BluetoothAdapter.STATE_OFF || value == BluetoothAdapter.STATE_TURNING_OFF) {
            close();
            main.removeCallbacks(retry);
            cancelAlarm();
            state("Bluetooth выключен · ожидаем включения");
          } else if (value == BluetoothAdapter.STATE_ON) {
            main.removeCallbacks(retry);
            main.post(retry);
          }
        }
      };

  public static final class Control extends BroadcastReceiver {
    public void onReceive(Context c, Intent i) {
      if ("stop".equals(i.getAction())) stop(c);
      else if ("tick".equals(i.getAction())) {
        BandService s = instance;
        if (s != null) s.tick("Таймер Android доставлен");
        else if (enabled(c))
          Vault.prefs(c)
              .edit()
              .putString("bandState", "Таймер доставлен, но служба отсутствует · открой Гекату")
              .apply();
      }
    }
  }

  static String powerState(Context c) {
    PowerManager p = (PowerManager) c.getSystemService(POWER_SERVICE);
    KeyguardManager k = (KeyguardManager) c.getSystemService(KEYGUARD_SERVICE);
    return "экран "
        + (p.isInteractive() ? "включён" : "выключен")
        + " · блокировка "
        + (k.isKeyguardLocked() ? "да" : "нет")
        + " · Doze "
        + (p.isDeviceIdleMode() ? "да" : "нет")
        + " · экономия "
        + (p.isPowerSaveMode() ? "да" : "нет")
        + " · оптимизация батареи "
        + (p.isIgnoringBatteryOptimizations(c.getPackageName()) ? "отключена" : "включена");
  }

  void state(String s) {
    Vault.prefs(this).edit().putString("bandState", s).apply();
    if (!stopping)
      ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
          .notify(NOTICE, notification(s));
  }

  void note(String s) {
    report
        .append(new java.text.SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date()))
        .append(" · ")
        .append(s)
        .append('\n');
    if (report.length() > 20000)
      report.delete(0, report.indexOf("\n", report.length() - 15000) + 1);
    main.removeCallbacks(persist);
    main.postDelayed(persist, 1000);
  }

  void pause(String s) {
    if (phase == READING_FILES) BandEvidence.attempt(this, true, false);
    else if (phase == READING_HISTORY || phase == READING_SNAPSHOT)
      BandEvidence.attempt(this, false, false);
    note(s);
    Vault.prefs(this).edit().putBoolean("bandEnabled", false).apply();
    state(s + " · открой Гекату");
    stopping = true;
    close();
    main.removeCallbacks(retry);
    cancelAlarm();
    stopSelf();
  }

  void finish(String s) {
    if (phase == READING_FILES) BandEvidence.attempt(this, true, false);
    else if (phase == READING_HISTORY) BandEvidence.attempt(this, false, false);
    BandUpload.schedule(this, true);
    Vault.prefs(this).edit().putInt("bandFailurePhase", phase).putLong("bandFailureAt", System.currentTimeMillis()).apply();
    if (phase == READING_FILES)
      Vault.prefs(this)
          .edit()
          .putString("bandFilesStatus", s + " · повтор через час; базовая очередь сохранена")
          .apply();
    note(s);
    int failedPhase = phase;
    boolean restoring = rebindSession;
    close();
    rebindSession = false;
    if (restoring) {
      pause(
          "Восстановление прервано; автоматический вход старым ключом не запускается. Пришли"
              + " диагностику, ключ и очередь сохранены");
      return;
    }
    allowPair = false;
    main.removeCallbacks(retry);
    cancelAlarm();
    if (!enabled(this) || stopping) return;
    if (failedPhase == CONFIGURING && ++setupFailures >= 3) {
      pause(
          "Настройка браслета не подтверждена после трёх попыток. Пришли диагностику; ключ"
              + " сохранён");
      return;
    }
    if (failedPhase == AUTHENTICATION && ++authFailures >= 3) {
      pause(
          "Три неудачных входа подряд. Проверь браслет и при необходимости восстанови сопряжение"
              + " вручную");
      return;
    }
    failures = Math.min(failures + 1, 6);
    long delay = BandPolicy.retry(failures);
    state("Связь прервана · повтор через " + delay / 1000 + " с");
    main.postDelayed(retry, delay);
    scheduleAlarm(delay);
  }

  public void onDestroy() {
    if (mediaWatch != null) mediaWatch.close();
    if (enabled(this))
      Vault.prefs(this)
          .edit()
          .putString("bandState", "Служба остановлена · нажми «Прочитать сейчас» для возобновления")
          .apply();
    stopping = true;
    close();
    main.removeCallbacksAndMessages(null);
    cancelAlarm();
    worker.shutdown();
    persist.run();
    try {
      unregisterReceiver(bluetooth);
    } catch (RuntimeException ignored) {
    }
    if (instance == this) instance = null;
    stopForeground(STOP_FOREGROUND_REMOVE);
    super.onDestroy();
  }

  void connect(BluetoothDevice device) {
    close();
    protocol = new BandProtocol();
    protocol.unsolicited =
        (service, command, fields) -> {
          if (sessionKey == null || !sessionVerified) return;
          int owner = generation;
          main.post(
              () -> {
                if (owner == generation && active) mediaEvent(command, fields);
              });
        };
    negotiating = false;
    phase = BOOTSTRAP;
    waiting = null;
    sentChunks = 0;
    totalChunks = 0;
    active = true;
    hold();
    state("Подключение к Band 11");
    int session = ++generation;
    note("Подключение GATT к выбранному Band 11…");
    main.postDelayed(timeout, 30000);
    try {
      keySlot = "bandKey." + BandAuth.hex(BandAuth.sha(BandAuth.utf(device.getAddress())));
      gatt =
          device.connectGatt(
              this,
              false,
              new BluetoothGattCallback() {
                void event(BluetoothGatt g, Runnable action) {
                  main.post(
                      () -> {
                        if (active && session == generation && g == gatt)
                          try {
                            action.run();
                          } catch (RuntimeException e) {
                            finish("Ошибка Bluetooth · " + e.getClass().getSimpleName());
                          }
                      });
                }

                public void onConnectionStateChange(BluetoothGatt g, int code, int state) {
                  event(
                      g,
                      () -> {
                        if (code != 0) {
                          finish("GATT ошибка: " + code);
                          return;
                        }
                        if (state == BluetoothProfile.STATE_CONNECTED) {
                          gattConnected = true;
                          note("GATT подключён. Читаем список сервисов…");
                          main.removeCallbacks(timeout);
                          main.postDelayed(timeout, 30000);
                          if (!g.discoverServices()) finish("Не удалось запросить сервисы");
                        } else if (state == BluetoothProfile.STATE_DISCONNECTED)
                          finish("Браслет закрыл соединение");
                      });
                }

                public void onServicesDiscovered(BluetoothGatt g, int code) {
                  event(
                      g,
                      () -> {
                        if (code != 0) {
                          finish("Ошибка поиска сервисов: " + code);
                          return;
                        }
                        BluetoothGattService service = g.getService(BandProtocol.SERVICE);
                        if (service == null) {
                          finish(
                              "Сервис Huawei FE86 отсутствует · найдено сервисов: "
                                  + g.getServices().size());
                          return;
                        }
                        write = service.getCharacteristic(BandProtocol.WRITE);
                        BluetoothGattCharacteristic read =
                            service.getCharacteristic(BandProtocol.READ);
                        if (write == null || read == null) {
                          finish("Нет характеристик Huawei FE01/FE02");
                          return;
                        }
                        note("Huawei FE86 / FE01 / FE02 найдены");
                        BluetoothGattDescriptor ccc = read.getDescriptor(BandProtocol.CCC);
                        if (ccc == null || !g.setCharacteristicNotification(read, true)) {
                          finish("Не удалось включить ответы браслета");
                          return;
                        }
                        int props = read.getProperties();
                        byte[] value =
                            (props & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0
                                ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                                : (props & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
                                    ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                                    : null;
                        if (value == null) {
                          finish("Характеристика не поддерживает уведомления");
                          return;
                        }
                        ccc.setValue(value);
                        if (!g.writeDescriptor(ccc))
                          finish("Не удалось отправить настройку уведомлений");
                      });
                }

                public void onDescriptorWrite(
                    BluetoothGatt g, BluetoothGattDescriptor d, int code) {
                  event(
                      g,
                      () -> {
                        if (!BandProtocol.CCC.equals(d.getUuid())) return;
                        if (code != 0) {
                          finish("Ошибка подписки на ответы: " + code);
                          return;
                        }
                        int props = write.getProperties();
                        if ((props & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0)
                          write.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                        else if ((props & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)
                            != 0)
                          write.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                        else {
                          finish("Нет доступного способа запроса");
                          return;
                        }
                        note("Запрос параметров протокола LinkParams…");
                        send(BandProtocol.query());
                      });
                }

                public void onCharacteristicWrite(
                    BluetoothGatt g, BluetoothGattCharacteristic c, int code) {
                  event(
                      g,
                      () -> {
                        if (code != 0) {
                          finish("Ошибка отправки запроса: " + code);
                          return;
                        }
                        sentChunks++;
                        writing = false;
                        nextWrite();
                      });
                }

                public void onCharacteristicChanged(
                    BluetoothGatt g, BluetoothGattCharacteristic c) {
                  byte[] a = c.getValue();
                  if (Build.VERSION.SDK_INT < 33) received(g, c, a == null ? null : a.clone());
                }

                public void onCharacteristicChanged(
                    BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
                  received(g, c, value.clone());
                }

                void received(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
                  if (!BandProtocol.READ.equals(c.getUuid())) return;
                  event(
                      g,
                      () -> {
                        try {
                          if (protocol == null || value == null) return;
                          Map<Integer, byte[]> tags = protocol.accept(value);
                          while (tags != null && active && session == generation) {
                            protocol.expect(-1, -1);
                            if (writing || !writes.isEmpty()) {
                              waiting = tags;
                              break;
                            } else response(tags);
                            if (active && session == generation)
                              tags = protocol.accept(new byte[0]);
                          }
                        } catch (IllegalArgumentException e) {
                          finish(e.getMessage());
                        }
                      });
                }
              },
              BluetoothDevice.TRANSPORT_LE);
      if (gatt == null) finish("Android не создал GATT-соединение");
    } catch (Exception e) {
      finish("Подключение недоступно · " + e.getClass().getSimpleName());
    }
  }

  void send(byte[] frame) {
    hold();
    if (writing || !writes.isEmpty()) {
      finish("Очередь Bluetooth занята");
      return;
    }
    sentChunks = 0;
    totalChunks = (frame.length + 19) / 20;
    for (int i = 0; i < frame.length; i += 20)
      writes.add(Arrays.copyOfRange(frame, i, Math.min(i + 20, frame.length)));
    main.removeCallbacks(timeout);
    main.postDelayed(timeout, phase == AUTHENTICATION ? 60000 : 30000);
    nextWrite();
  }

  void nextWrite() {
    if (!active || writing) return;
    if (writes.isEmpty()) {
      if (phase == READING_FILES && files != null && files.noReply()) {
        main.removeCallbacks(timeout);
        protocol.expect(-1, -1);
        try {
          fileRequest(files.next());
        } catch (Exception e) {
          finish("Ошибка следующего файла истории");
        }
        return;
      }
      if (phase == SENDING_MEDIA && mediaNoReply) {
        main.removeCallbacks(timeout);
        protocol.expect(-1, -1);
        noticeIdle();
        return;
      }
      if (phase == CONFIGURING && setup != null && !setup.waitsForReply()) {
        main.removeCallbacks(timeout);
        protocol.expect(-1, -1);
        waiting = null;
        note("01/3E передана Android · команда без ответного пакета; переходим дальше");
        int session = generation;
        main.postDelayed(
            () -> {
              if (!active || session != generation || phase != CONFIGURING || setup.waitsForReply())
                return;
              try {
                continueSetup(setup.sentWithoutReply());
              } catch (Exception e) {
                finish("Не удалось продолжить настройку");
              }
            },
            100);
        return;
      }
      if (phase == AUTHENTICATION)
        note("Android подтвердил отправку запроса HiChain · фрагментов: " + sentChunks);
      if (waiting != null) {
        Map<Integer, byte[]> tags = waiting;
        waiting = null;
        response(tags);
        if (active)
          try {
            Map<Integer, byte[]> buffered;
            while (active && (buffered = protocol.accept(new byte[0])) != null) {
              protocol.expect(-1, -1);
              if (writing) {
                waiting = buffered;
                break;
              } else response(buffered);
            }
          } catch (IllegalArgumentException e) {
            finish(e.getMessage());
          }
      }
      return;
    }
    byte[] chunk = writes.remove();
    write.setValue(chunk);
    writing = true;
    if (!gatt.writeCharacteristic(write)) finish("Android не принял фрагмент запроса");
  }

  void request(BandAuth.Request next) {
    protocol.expect(next.service, next.command);
    note(next.status);
    send(BandProtocol.frame(next.service, next.command, next.tlv));
  }

  void response(Map<Integer, byte[]> tags) {
    try {
      if (phase == READING_FILES) {
        if (SystemClock.elapsedRealtime() - filesStarted > 120000)
          throw new IllegalArgumentException("Лимит времени файловой истории; повтор через час");
        BandAuth.Request next;
        if (tags.containsKey(-1)) next = files.data(tags.get(-1), sessionKey);
        else {
          BandAuth.checkResult(tags);
          Map<Integer, byte[]> plain =
              (files.stage == -3 || files.stage == 0 || files.stage == 1)
                  ? BandSetup.response(sessionKey, tags)
                  : BandAuth.decrypted(sessionKey, tags);
          next = files.accept(plain);
        }
        if (next == null && !files.done) {
          protocol.expect(0x2c, 5);
          main.removeCallbacks(timeout);
          main.postDelayed(timeout, 15000);
          return;
        }
        fileRequest(next);
        return;
      }
      if (phase == SENDING_MEDIA) {
        Map<Integer, byte[]> data = BandSetup.response(sessionKey, tags);
        BandAuth.checkResult(data);
        if (!data.containsKey(127))
          throw new IllegalArgumentException("Нет явного подтверждения состояния плеера");
        Vault.prefs(this)
            .edit()
            .putString(
                "bandMediaStatus", "Браслет ответил на состояние плеера · проверь управление")
            .apply();
        noticeIdle();
        return;
      }
      if (phase == SENDING_NOTICE) {
        noticeResponse(tags);
        return;
      }
      if (phase == CONFIGURING) {
        note(responseShape(tags));
        Map<Integer, byte[]> plain = BandSetup.response(sessionKey, tags);
        boolean account = setup.accountResponse();
        if (account) note("Структура ответа 1A/05 после проверки: " + responseShape(plain));
        BandAuth.Request next = setup.accept(plain);
        note(
            account && !plain.containsKey(127)
                ? "Ответ 1A/05 получен без отдельного кода результата; привязка ещё не подтверждена"
                : "Ответ настройки проверен");
        continueSetup(next);
        return;
      }
      if (phase == READING_HISTORY) {
        BandAuth.checkResult(tags);
        Map<Integer, byte[]> plain = BandAuth.decrypted(sessionKey, tags);
        BandAuth.checkResult(plain);
        JSONArray records = new JSONArray();
        BandAuth.Request next = history.accept(plain, records);
        queueThen(records, next);
        return;
      }
      if (phase == READING_SNAPSHOT) {
        note(responseShape(tags));
        BandAuth.checkResult(tags);
        Map<Integer, byte[]> plain = BandAuth.decrypted(sessionKey, tags);
        BandAuth.checkResult(plain);
        long steps = BandProtocol.steps(plain);
        verifiedReading = true;
        sessionVerified = true;
        note("GCM-проверка ответа пройдена · счётчик шагов: " + steps);
        long until = System.currentTimeMillis();
        String device =
            keySlot
                .substring("bandKey.".length(), "bandKey.".length() + 16)
                .toLowerCase(java.util.Locale.ROOT);
        if (!configured) throw new IllegalStateException("Настройка подключения не завершена");
        long last = Vault.prefs(this).getLong(keySlot + ".readAt", 0);
        JSONObject cfg = BandUpload.config(this);
        boolean metrics =
            cfg != null
                && (cfg.optBoolean("bandMetrics")
                    || Vault.prefs(this).getBoolean("bandMetrics." + readTarget, false));
        boolean backfill =
            metrics && !Vault.prefs(this).getBoolean(keySlot + ".metricsBackfill", false);
        history = new BandHistory(device, BandPolicy.historyFrom(until, last, backfill), until);
        history.metricsEnabled = metrics;
        readingHistory = forceFiles || backfill || BandPolicy.due(until, last, BandPolicy.HISTORY);
        long stamp = until / 60000 * 60000;
        JSONObject snapshot =
            history
                .record("band", stamp, stamp + 1)
                .put("battery", lastBattery)
                .put("steps", steps);
        phase = READING_HISTORY;
        queueThen(new JSONArray().put(snapshot), readingHistory ? history.begin() : null);
        return;
      }
      if (phase == READING_BATTERY) {
        note(responseShape(tags));
        Map<Integer, byte[]> plain = BandAuth.batteryResponse(sessionKey, tags);
        int battery = BandProtocol.number(plain, 1);
        lastBattery = battery;
        note(
            "Заряд: "
                + battery
                + "% · "
                + (BandProtocol.number(tags, 124) > 0
                    ? "GCM проверен"
                    : "открытый ответ, допустимый для заряда"));
        phase = READING_SNAPSHOT;
        request(
            new BandAuth.Request(
                7,
                3,
                BandAuth.encrypted(sessionKey, new byte[] {1, 0}),
                "Запрос зашифрованного счётчика шагов · 07/03"));
        return;
      }
      if (phase == AUTHENTICATION) {
        note("Ответ HiChain · тип: " + BandProtocol.number(tags, 4));
        BandAuth.Request next = auth.accept(tags);
        if (next != null) {
          request(next);
          return;
        }
        sessionKey = auth.sessionKey();
        note(
            "Получено уведомление завершения HiChain. Сначала завершаем настройку подключения,"
                + " затем проверяем измерения…");
        setup = new BandSetup();
        phase = CONFIGURING;
        secure(setup.begin());
        return;
      }
      if (negotiating) {
        note(BandProtocol.negotiationReport(tags));
        BandAuth.validateNegotiation(tags, !Vault.prefs(this).getString(keySlot, "").isEmpty());
        byte[] saved = null, peer = null;
        String sealed = Vault.prefs(this).getString(keySlot, "");
        if (!sealed.isEmpty()) {
          org.json.JSONObject key = new org.json.JSONObject(Vault.open(sealed));
          if (!key.getString("identity")
              .equals(new String(identityBytes, java.nio.charset.StandardCharsets.US_ASCII)))
            throw new java.security.GeneralSecurityException(
                "Идентификатор не соответствует сохранённому ключу");
          saved = BandAuth.unhex(key.getString("token"));
          peer = BandAuth.unhex(key.getString("peer"));
        }
        if (rebindSession && BandProtocol.number(tags, 2) != 1)
          throw new java.security.GeneralSecurityException(
              "Браслет сейчас выбрал вариант 2. Используй обычную кнопку чтения с сохранённым"
                  + " ключом.");
        if (saved == null && !allowPair) {
          pause("Нет ключа браслета. Открой Гекату и выбери браслет для сопряжения.");
          return;
        }
        note(
            rebindSession
                ? "Восстановление сопряжения по запросу пользователя · подтвердите на браслете."
                    + " Прежний ключ пока сохранён."
                : saved == null
                    ? "Сохранённого ключа нет · начинаем первичное сопряжение"
                    : "Найден сохранённый ключ · повторный вход без нового PIN");
        auth =
            new BandAuth(
                identityBytes,
                saved,
                peer,
                pinMethod,
                (token, remote) -> {
                  org.json.JSONObject data =
                      new org.json.JSONObject()
                          .put(
                              "identity",
                              new String(identityBytes, java.nio.charset.StandardCharsets.US_ASCII))
                          .put("token", BandAuth.hex(token))
                          .put("peer", BandAuth.hex(remote));
                  String encoded = Vault.seal(data.toString());
                  android.content.SharedPreferences.Editor editor = Vault.prefs(this).edit();
                  String oldKey = Vault.prefs(this).getString(keySlot, "");
                  if (rebindSession && !oldKey.isEmpty())
                    editor.putString(keySlot + ".previous", oldKey);
                  if (!editor.putString(keySlot, encoded).commit())
                    throw new java.io.IOException("Ключ не сохранён");
                  note("Ключ браслета сохранён в защищённом хранилище");
                });
        phase = AUTHENTICATION;
        request(auth.start(rebindSession));
        allowPair = false;
        return;
      }
      note(BandProtocol.report(tags));
      if (BandProtocol.number(tags, 7) != 4)
        throw new java.security.GeneralSecurityException("Неподдержанный тип устройства");
      byte[] version = tags.get(5);
      if (version == null || version.length < 2 || version[1] != 1)
        throw new java.security.GeneralSecurityException("Неподдержанная версия авторизации");
      pinMethod = BandProtocol.number(tags, 12);
      if (pinMethod < 0) pinMethod = 0;
      String identity = Vault.prefs(this).getString("bandProbeIdentity", "");
      if (identity.isEmpty()) {
        identity = BandAuth.hex(BandAuth.random(16));
        if (!Vault.prefs(this).edit().putString("bandProbeIdentity", identity).commit())
          throw new java.io.IOException();
      }
      if (!identity.matches("[A-F0-9]{32}")) throw new IllegalStateException();
      identityBytes = BandAuth.utf(identity);
      negotiating = true;
      protocol.expect(1, 0x33);
      note("Запрос SecurityNegotiation · режим 4…");
      send(BandProtocol.negotiation(identityBytes));
    } catch (BandAuth.RemoteError e) {
      Vault.prefs(this).edit().putLong("bandRemoteError", e.code).putLong("bandRemoteErrorAt", System.currentTimeMillis()).apply();
      if (phase == READING_FILES) {
        historyIncomplete = true;
        note("Расширенная история отклонена · " + e.code);
        if (e.code == 100004 || e.code == 100005) {
          finish(e.getMessage());
          return;
        }
        try {
          if (files.stage < 0) {
            fileRequest(
                (files.stage == -1 || files.stage == -4) ? files.nextWorkout() : files.fileBegin());
          } else if (files.stage == 2) {
            fileRequest(files.next());
          } else filesDone("Расширенная история недоступна · код " + e.code);
        } catch (Exception failure) {
          finish("Ошибка файловой истории");
        }
        return;
      }
      if (phase == SENDING_MEDIA) {
        mediaSignature = null;
        mediaWrites.clear();
        note("Плеер · отказ браслета " + e.code);
        Vault.prefs(this)
            .edit()
            .putString("bandMediaStatus", "Браслет отклонил состояние плеера · " + e.code)
            .apply();
        noticeIdle();
        return;
      }
      if (phase == SENDING_NOTICE) {
        noticeFailed = true;
        notices.clear();
        BandNotices.status(this, "Браслет отклонил уведомления · код " + e.code);
        note("Уведомления · отказ " + e.code);
        noticeIdle();
        return;
      }
      if (phase == CONFIGURING && setup != null && setup.optionalProbe()) {
        note(
            "Проверка поддержки режима без аккаунта отклонена · код "
                + e.code
                + "; привязка не подтверждена");
        try {
          continueSetup(setup.skipProbe());
        } catch (Exception failure) {
          finish("Не удалось продолжить настройку");
        }
        return;
      }
      if (e.code == 100004
          && verifiedReading
          && phase >= READING_BATTERY
          && phase <= READING_HISTORY
          && remoteRetries++ == 0) {
        finish(e.getMessage() + " · один повтор с новым GATT-сеансом и сохранённым ключом");
      } else
        pause(e.getMessage() + " · автоматический повтор остановлен; ключ и очередь сохранены");
    } catch (Exception e) {
      String message =
          e instanceof java.security.GeneralSecurityException
                  || e instanceof IllegalArgumentException
              ? e.getMessage()
              : null;
      if (e instanceof IllegalArgumentException
          && phase == READING_FILES
          && files != null
          && files.stage < 0) {
        historyIncomplete = true;
        note("Пропущена необязательная история тренировок · " + message);
        try {
          fileRequest(
              (files.stage == -1 || files.stage == -4) ? files.nextWorkout() : files.fileBegin());
        } catch (Exception failure) {
          finish("Не удалось продолжить расширенную историю");
        }
        return;
      }
      if (e instanceof IllegalArgumentException && phase == READING_FILES && files != null) {
        historyIncomplete = true;
        files.records = new JSONArray();
        filesDone("Расширенные данные пропущены: " + message);
        return;
      }
      if (e instanceof IllegalArgumentException && phase == SENDING_NOTICE) {
        noticeFailed = true;
        notices.clear();
        BandNotices.status(this, "Формат ответа уведомлений не поддержан; измерения продолжаются");
        note("Уведомления · " + message);
        noticeIdle();
        return;
      }
      if (e instanceof IllegalArgumentException && phase == SENDING_MEDIA) {
        mediaSignature = null;
        Vault.prefs(this).edit().putString("bandMediaStatus", message).apply();
        note("Плеер · " + message);
        noticeIdle();
        return;
      }
      if (e instanceof java.security.GeneralSecurityException)
        pause(message == null ? "Проверка ключа не пройдена" : message);
      else finish(message == null ? "Обмен остановлен · " + e.getClass().getSimpleName() : message);
    }
  }

  boolean filesDue() {
    if (setup == null || history == null) return false;
    long now = System.currentTimeMillis(),
        last = Vault.prefs(this).getLong(keySlot + ".filesAt", 0);
    return forceFiles || last <= 0 || now < last || now - last >= BandPolicy.FILES;
  }

  boolean beginFiles() {
    try {
      if (!filesDue()) return false;
      long now = System.currentTimeMillis();
      forceFiles = false;
      Vault.prefs(this).edit().putLong(keySlot + ".filesAt", now).apply();
      JSONObject cfg = BandUpload.config(this);
      files =
          new BandFiles(
              history,
              setup.dictSleep,
              setup.bedTime,
              cfg != null
                  && (cfg.optBoolean("bandExtended")
                      || Vault.prefs(this).getBoolean("bandExtended." + readTarget, false)));
      filesStarted = SystemClock.elapsedRealtime();
      phase = READING_FILES;
      fileRequest(files.begin());
      return true;
    } catch (Exception e) {
      finish("Не удалось начать расширенную историю");
      return true;
    }
  }

  void fileRequest(BandAuth.Request next) throws Exception {
    if (next == null) {
      filesDone(files.status);
      return;
    }
    if (files.records.length() > 0) {
      JSONArray batch = files.records;
      int owner = generation;
      String destination = readTarget;
      hold();
      main.removeCallbacks(timeout);
      main.postDelayed(timeout, 30000);
      worker.execute(
          () -> {
            try {
              JSONArray part = new JSONArray();
              for (int i = 0; i < batch.length(); i++) {
                part.put(batch.getJSONObject(i));
                if (part.length() == 500) {
                  BandUpload.enqueue(this, part, false, destination);
                  part = new JSONArray();
                }
              }
              if (part.length() > 0) BandUpload.enqueue(this, part, false, destination);
              main.post(
                  () -> {
                    if (owner != generation || !active || files == null) return;
                    files.savedRecords += batch.length();
                    files.records = new JSONArray();
                    try {
                      sendFileRequest(next);
                    } catch (Exception e) {
                      finish("Не удалось продолжить файл после сохранения очереди");
                    }
                  });
            } catch (Exception e) {
              main.post(
                  () -> {
                    if (owner == generation && active)
                      finish("Файл не подтверждён: не удалось сохранить очередь");
                  });
            }
          });
      return;
    }
    sendFileRequest(next);
  }

  void sendFileRequest(BandAuth.Request next) throws Exception {
    if (files.rawRequest()) request(next);
    else secure(next);
    if (files.stage == 5) protocol.expect(0x2c, 5);
  }

  void filesDone(String message) {
    JSONArray records = files.records;
    if (files.workoutSupported != null) Vault.prefs(this).edit().putBoolean("bandEvidence.workout.supported", files.workoutSupported).apply();
    if (files.fileSupported != null) Vault.prefs(this).edit().putBoolean("bandEvidence.files.supported", files.fileSupported).apply();
    pendingExtendedEvidence = !historyIncomplete && files.done;
    files = null;
    note(message);
    Vault.prefs(this).edit().putString("bandFilesStatus", message).apply();
    phase = READING_HISTORY;
    queueThen(records, null);
  }

  void queueThen(JSONArray records, BandAuth.Request next) {
    boolean markComplete = readingHistory && !historyIncomplete && next == null && !filesDue();
    hold();
    main.removeCallbacks(timeout);
    main.postDelayed(timeout, 30000);
    int session = generation;
    String destination = readTarget;
    worker.execute(
        () -> {
          try {
            LinkedHashMap<String, JSONObject> unique = new LinkedHashMap<>();
            for (int i = 0; i < records.length(); i++) {
              JSONObject row = records.getJSONObject(i);
              unique.put(row.getString("id"), row);
            }
            JSONArray batch = new JSONArray();
            for (JSONObject row : unique.values()) {
              batch.put(row);
              if (batch.length() == 500) {
                BandUpload.enqueue(this, batch, false, destination);
                batch = new JSONArray();
              }
            }
            if (batch.length() > 0) BandUpload.enqueue(this, batch, false, destination);
            if (markComplete) BandUpload.enqueue(this, new JSONArray(), true, destination);
            main.post(
                () -> {
                  if (session != generation || !active) return;
                  note("Сохранено в очередь записей: " + records.length());
                  if (next == null) {
                    note(
                        "Доступная история прочитана. Неизвестных стадий сна: "
                            + history.unknownSleep);
                    completed();
                  } else
                    try {
                      request(
                          new BandAuth.Request(
                              next.service,
                              next.command,
                              BandAuth.encrypted(sessionKey, next.tlv),
                              next.status));
                    } catch (Exception e) {
                      finish("Не удалось сформировать запрос истории");
                    }
                });
          } catch (Exception e) {
            main.post(
                () -> {
                  if (session == generation && active)
                    finish(
                        e.getMessage() == null ? "Ошибка очереди; повтори чтение" : e.getMessage());
                });
          }
        });
  }

  void close() {
    pendingExtendedEvidence = null;
    files = null;
    pendingBond = null;
    main.removeCallbacks(bondTimeout);
    gattConnected = false;
    mediaSignature = null;
    main.removeCallbacks(mediaUpdate);
    sessionVerified = false;
    mediaWrites.clear();
    if (!notices.isEmpty())
      BandNotices.status(this, "Связь прервана · ожидавшие уведомления удалены");
    notices.clear();
    noticeReady = false;
    noticeFailed = false;
    noticeLimit = 15;
    mediaInfoAt = 0;
    release();
    if (auth != null) {
      auth.destroy();
      auth = null;
    }
    if (sessionKey != null) {
      Arrays.fill(sessionKey, (byte) 0);
      sessionKey = null;
    }
    active = false;
    writes.clear();
    writing = false;
    waiting = null;
    generation++;
    main.removeCallbacks(timeout);
    BluetoothGatt old = gatt;
    gatt = null;
    write = null;
    if (old != null) {
      try {
        old.disconnect();
      } catch (RuntimeException ignored) {
      }
      try {
        old.close();
      } catch (RuntimeException ignored) {
      }
    }
  }

  void offerNotice(BandNotices.Item item, boolean test) {
    main.post(
        () -> {
          if (!enabled(this) || !BandNotices.enabled(this) || stopping) return;
          if (!test
              && !Vault.prefs(this)
                  .getStringSet(BandNotices.APPS, Collections.emptySet())
                  .contains(item.app)) return;
          if (noticeFailed) {
            BandNotices.status(
                this, "Уведомления недоступны в этом соединении; измерения продолжаются");
            return;
          }
          try {
            String key = BandAuth.hex(BandAuth.sha(BandAuth.utf(item.key))),
                fingerprint =
                    BandAuth.hex(BandAuth.sha(BandAuth.utf(item.title + "\n" + item.body)));
            if (!test && fingerprint.equals(noticeSeen.get(key))) return;
            noticeSeen.put(key, fingerprint);
            while (noticeSeen.size() > 128)
              noticeSeen.remove(noticeSeen.keySet().iterator().next());
            notices.removeIf(n -> n.key.equals(item.key));
            if (notices.size() >= 20) notices.removeFirst();
            notices.add(item);
            BandNotices.status(this, "Ожидают передачи на браслет: " + notices.size());
            pumpNotices();
          } catch (Exception e) {
            BandNotices.status(this, "Не удалось подготовить уведомление");
          }
        });
  }

  void withdrawNotice(String key) {
    main.post(
        () -> {
          notices.removeIf(n -> n.key.equals(key));
          try {
            noticeSeen.remove(BandAuth.hex(BandAuth.sha(BandAuth.utf(key))));
          } catch (Exception ignored) {
          }
        });
  }

  void noticePreferencesChanged() {
    main.post(
        () -> {
          if (!BandNotices.enabled(this)) {
            notices.clear();
            noticeSeen.clear();
            BandNotices.status(this, "Пересылка выключена");
          } else {
            Set<String> selected =
                Vault.prefs(this).getStringSet(BandNotices.APPS, Collections.emptySet());
            notices.removeIf(n -> !n.key.equals("test") && !selected.contains(n.app));
            noticeSeen.clear();
          }
          pumpNotices();
        });
  }

  void pumpNotices() {
    if (!active || phase != IDLE || !configured || !sessionVerified || stopping) return;
    if (alarmDue > 0 && SystemClock.elapsedRealtime() >= alarmDue) {
      tick("Чтение перед передачей на браслет");
      return;
    }
    if (!BandMedia.enabled(this)) mediaWrites.clear();
    if (!mediaWrites.isEmpty()) {
      try {
        BandAuth.Request next = mediaWrites.removeFirst();
        phase = SENDING_MEDIA;
        mediaNoReply = next.command != 2;
        secure(next);
      } catch (Exception e) {
        finish("Ошибка отправки данных плеера");
      }
      return;
    }
    if (noticeFailed || !BandNotices.enabled(this)) return;
    long now = SystemClock.elapsedRealtime();
    while (!notices.isEmpty() && now - notices.peek().time > BandNotices.TTL) notices.removeFirst();
    if (notices.isEmpty()) return;
    if (alarmDue > 0 && now >= alarmDue) {
      tick("Чтение перед очередью уведомлений");
      return;
    }
    try {
      phase = SENDING_NOTICE;
      if (!noticeReady) {
        noticeStage = 0;
        secure(
            new BandAuth.Request(
                3,
                BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {2}, 3, new byte[] {1, 2, 4})),
                "Проверка поддержки уведомлений · 01/03 для 02"));
      } else sendNotice();
    } catch (Exception e) {
      finish("Не удалось отправить уведомление");
    }
  }

  void sendNotice() throws Exception {
    if (notices.isEmpty() || !BandNotices.enabled(this)) {
      noticeIdle();
      return;
    }
    BandNotices.Item item = notices.removeFirst();
    if (SystemClock.elapsedRealtime() - item.time > BandNotices.TTL) {
      noticeIdle();
      return;
    }
    noticeStage = 2;
    noticeId = (noticeId + 1) & 65535;
    secure(
        new BandAuth.Request(
            2,
            1,
            BandNotices.packet(noticeId, item.app, item.title, item.body, noticeLimit),
            "Отправка текстового уведомления · 02/01"));
  }

  void enableNotices() throws Exception {
    noticeStage = 1;
    secure(
        new BandAuth.Request(
            2,
            4,
            BandAuth.tlv(129, BandAuth.tlv(2, new byte[] {1}, 3, new byte[] {1})),
            "Включение уведомлений · 02/04"));
  }

  void noticeResponse(Map<Integer, byte[]> tags) throws Exception {
    Map<Integer, byte[]> plain = BandSetup.response(sessionKey, tags);
    BandAuth.checkResult(plain);
    if (noticeStage == 0) {
      byte[] body = plain.get(129);
      if (body == null) throw new IllegalArgumentException("Нет возможностей уведомлений");
      Map<Integer, byte[]> fields = BandProtocol.parseTlv(body);
      byte[] flags = fields.get(4);
      if (BandProtocol.number(fields, 2) != 2
          || flags == null
          || flags.length != 3
          || (flags[0] != 0 && flags[0] != 1)
          || (flags[1] != 0 && flags[1] != 1)
          || (flags[2] != 0 && flags[2] != 1))
        throw new IllegalArgumentException("Неверные возможности уведомлений");
      if (flags[0] != 1 || flags[2] != 1) {
        noticeFailed = true;
        notices.clear();
        BandNotices.status(this, "Браслет не подтвердил поддержку уведомлений 02/01 и 02/04");
        noticeIdle();
        return;
      }
      if (flags[1] == 1) {
        noticeStage = 3;
        secure(
            new BandAuth.Request(
                2, 2, new byte[] {1, 0}, "Ограничения текста уведомлений · 02/02"));
      } else enableNotices();
      return;
    }
    if (noticeStage == 3) {
      noticeLimit = BandNotices.contentLimit(plain);
      enableNotices();
      return;
    }
    if (noticeStage == 1) {
      noticeReady = true;
      sendNotice();
      return;
    }
    BandNotices.status(
        this,
        "Браслет ответил на отправку · "
            + new java.text.SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date())
            + " · проверь экран браслета");
    note("Ответ на уведомление получен; показ на экране отдельно не подтверждается");
    noticeIdle();
  }

  void noticeIdle() {
    main.removeCallbacks(timeout);
    phase = IDLE;
    protocol.expect(-1, -1);
    release();
    if (alarmDue > 0 && SystemClock.elapsedRealtime() >= alarmDue) tick("Чтение после уведомлений");
    else main.postDelayed(this::pumpNotices, 300);
  }

  void mediaEvent(int command, Map<Integer, byte[]> tags) {
    if (!BandMedia.enabled(this)
        || sessionKey == null
        || !sessionVerified
        || mediaWrites.size() > 6) return;
    if (command == 1) {
      long now = SystemClock.elapsedRealtime();
      if (now - mediaInfoAt < 1000) return;
      mediaInfoAt = now;
    }
    try {
      Map<Integer, byte[]> plain = BandSetup.response(sessionKey, tags);
      BandAuth.checkResult(plain);
      if (command == 3 && !BandMedia.control(this, plain)) {
        note("Плеер: нет активной сессии Android или действие недоступно");
        return;
      }
      mediaWrites.add(
          new BandAuth.Request(
              0x25,
              command,
              BandAuth.tlv(127, BandHistory.integer(100000)),
              "Подтверждение команды плеера"));
      int owner = generation;
      main.postDelayed(
          () -> {
            if (owner != generation || !active || !BandMedia.enabled(this)) return;
            try {
              mediaWrites.removeIf(r -> r.command == 2);
              mediaWrites.add(
                  new BandAuth.Request(
                      0x25,
                      2,
                      BandMedia.info(this),
                      "Название и состояние активного плеера Android"));
              pumpNotices();
            } catch (SecurityException e) {
              note("Плеер: разреши доступ к уведомлениям Android");
            }
          },
          150);
      pumpNotices();
    } catch (java.security.GeneralSecurityException e) {
      pause("Проверка команды плеера не пройдена");
    } catch (Exception e) {
      note("Плеер: проверь доступ к уведомлениям и активное воспроизведение");
    }
  }

  void testMedia() {
    main.post(
        () -> {
          String result = BandMedia.diagnostic(this);
          note("Проверка плеера · " + result);
          Vault.prefs(this).edit().putString("bandMediaStatus", result).apply();
          if (!BandMedia.enabled(this) || !active || !sessionVerified) return;
          try {
            if (BandMedia.current(this) == null) return;
          } catch (SecurityException denied) {
            return;
          }
          mediaSignature = null;
          refreshMediaBridge();
        });
  }

  void refreshMediaBridge() {
    main.post(
        () -> {
          if (stopping) return;
          if (mediaWatch != null) mediaWatch.refresh();
          if (!BandMedia.enabled(this)) {
            mediaWrites.clear();
            mediaSignature = null;
            Vault.prefs(this)
                .edit()
                .putString("bandMediaStatus", "Управление плеером выключено")
                .apply();
          } else queueMediaInfo();
        });
  }

  void queueMediaInfo() {
    if (stopping || !active || !configured || !sessionVerified || !BandMedia.enabled(this)) return;
    try {
      byte[] info = BandMedia.info(this);
      if (Arrays.equals(info, mediaSignature)) return;
      mediaSignature = info.clone();
      mediaWrites.removeIf(r -> r.command == 2);
      mediaWrites.add(
          new BandAuth.Request(0x25, 2, info, "Состояние плеера Android → браслет · 25/02"));
      Vault.prefs(this)
          .edit()
          .putString("bandMediaStatus", "Состояние плеера в очереди Bluetooth")
          .apply();
      pumpNotices();
    } catch (SecurityException e) {
      Vault.prefs(this)
          .edit()
          .putString(
              "bandMediaStatus", "Нет доступа к медиасессиям · разреши доступ к уведомлениям")
          .apply();
    }
  }

  String responseShape(Map<Integer, byte[]> fields) {
    StringBuilder out = new StringBuilder("Поля ответа:");
    for (Map.Entry<Integer, byte[]> e : fields.entrySet())
      out.append(' ')
          .append(Integer.toHexString(e.getKey()))
          .append('(')
          .append(e.getValue().length)
          .append(')');
    out.append(" · признак шифрования: ").append(BandProtocol.number(fields, 124));
    return out.toString();
  }
}
