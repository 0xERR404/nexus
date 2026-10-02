package xyz.nexus404.hecate;

import android.app.Notification;
import android.content.ComponentName;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class BankListener extends NotificationListenerService {
  private static volatile BankListener live;

  public static boolean connected() {
    return live != null;
  }

  public static void inspectCurrent(android.content.Context context) {
    BankListener listener = live;
    if (listener == null) {
      Vault.status(
          context,
          "Слушатель Android не подключён. Выключи и снова включи доступ к уведомлениям в"
              + " настройках Android.");
      requestRebind(new ComponentName(context, BankListener.class));
      return;
    }
    try {
      JSONObject config = Vault.config(context);
      if (config == null) {
        Vault.status(context, "Сначала подключи источник");
        return;
      }
      if (BankSms.enabled(context)) {
        Vault.status(context, "Выбран приём SMS: проверка пушей отключена");
        return;
      }
      if (!Vault.active(context)) {
        Vault.status(context, "Сначала возобнови приём");
        return;
      }
      StatusBarNotification[] notifications = listener.getActiveNotifications();
      int count = 0;
      if (notifications != null)
        for (StatusBarNotification n : notifications)
          if (n.getPackageName().equals(config.getString("package"))) {
            count++;
            listener.onNotificationPosted(n);
          }
      if (count == 0)
        Vault.prefs(context)
            .edit()
            .putString("capture", "Среди текущих уведомлений нет выбранного банка")
            .apply();
      Vault.status(
          context,
          "Проверено текущих уведомлений банка: " + count + ". Повторы в очереди не добавляются.");
    } catch (Exception error) {
      Vault.status(
          context, "Android не разрешил прочитать текущие уведомления. Проверь доступ Гекаты.");
    }
  }

  private final ExecutorService worker = Executors.newSingleThreadExecutor();

  public void onListenerConnected() {
    live = this;
    if (BandService.instance != null) BandService.instance.refreshMediaBridge();
    Vault.prefs(this).edit().putBoolean("listener", true).apply();
    Sender.schedule(this);
  }

  public void onListenerDisconnected() {
    live = null;
    if (BandService.instance != null) BandService.instance.refreshMediaBridge();
    Vault.prefs(this).edit().putBoolean("listener", false).apply();
    requestRebind(new ComponentName(this, BankListener.class));
  }

  public void onNotificationPosted(StatusBarNotification sbn) {
    try {
      BandNotices.capture(this, sbn);
    } catch (RuntimeException ignored) {
    }
    if (!Vault.active(this) || BankSms.enabled(this)) return;
    try {
      JSONObject config = Vault.config(this);
      if (config == null || !sbn.getPackageName().equals(config.getString("package"))) return;
      Vault.prefs(this)
          .edit()
          .putLong("bankEvents", Vault.prefs(this).getLong("bankEvents", 0) + 1)
          .putLong("bankLast", System.currentTimeMillis())
          .apply();
      Notification n = sbn.getNotification();
      if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) {
        Vault.prefs(this)
            .edit()
            .putString("capture", "Получена сводка группы; ожидается отдельное уведомление покупки")
            .apply();
        return;
      }
      Bundle e = n.extras;
      CharSequence body = e.getCharSequence(Notification.EXTRA_BIG_TEXT);
      if (body == null || body.length() == 0) body = e.getCharSequence(Notification.EXTRA_TEXT, "");
      if (body == null || body.length() == 0) {
        CharSequence[] lines = e.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
        if (lines != null) body = android.text.TextUtils.join("\n", lines);
      }
      String title = String.valueOf(e.getCharSequence(Notification.EXTRA_TITLE, "")),
          content = body == null ? "" : body.toString(),
          text = title.trim().equals(content.trim()) ? content : title + "\n" + content;
      Expense expense = Expense.parse(text, sbn.getPackageName());
      if (expense == null) {
        Vault.prefs(this)
            .edit()
            .putString(
                "capture",
                text.trim().isEmpty()
                    ? "Android передал уведомление без текста"
                    : "Получено, но сумма не распознана или сообщение отфильтровано")
            .putLong("skipped", Vault.prefs(this).getLong("skipped", 0) + 1)
            .apply();
        return;
      }
      Vault.prefs(this)
          .edit()
          .putString("capture", "Операция распознана; сохранение в очередь")
          .apply();
      final JSONObject payload =
          new JSONObject()
              .put("package", sbn.getPackageName())
              .put("occurredAt", sbn.getPostTime())
              .put(
                  "operation",
                  new JSONObject()
                      .put("kind", expense.kind)
                      .put("amountMinor", expense.amount)
                      .put("currency", expense.currency)
                      .put("merchant", expense.merchant));
      String raw =
          sbn.getPackageName()
              + "\n"
              + sbn.getKey()
              + "\n"
              + sbn.getPostTime()
              + "\n"
              + expense.amount
              + "\n"
              + expense.currency
              + (expense.kind.equals("expense") ? "" : "\n" + expense.kind);
      byte[] bytes =
          MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder();
      for (byte b : bytes) hex.append(String.format("%02x", b & 255));
      payload.put("eventId", hex.toString());
      final String connection = Vault.prefs(this).getString("connection", "");
      worker.execute(
          () -> {
            try {
              synchronized (Vault.class) {
                if (!connection.equals(Vault.prefs(this).getString("connection", ""))
                    || !Vault.active(this)
                    || BankSms.enabled(this)) return;
                try (Queue q = new Queue(this)) {
                  q.add(payload.getString("eventId"), payload);
                }
              }
              Sender.schedule(this);
            } catch (Exception failure) {
              Vault.status(
                  this, "Не удалось сохранить операцию. Проверь свободное место и очередь.");
            }
          });
    } catch (Exception failure) {
      Vault.status(this, "Не удалось обработать уведомление.");
    }
  }

  public void onNotificationRemoved(StatusBarNotification sbn) {
    BandService s = BandService.instance;
    if (s != null && sbn != null) s.withdrawNotice(sbn.getKey());
  }

  public void onDestroy() {
    if (live == this) live = null;
    Vault.prefs(this).edit().putBoolean("listener", false).apply();
    worker.shutdown();
    super.onDestroy();
  }
}
