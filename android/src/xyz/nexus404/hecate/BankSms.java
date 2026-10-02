package xyz.nexus404.hecate;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

public final class BankSms extends BroadcastReceiver {
  static boolean enabled(Context c) {
    return Vault.prefs(c).getBoolean("sms", false)
        && c.checkSelfPermission(Manifest.permission.RECEIVE_SMS)
            == PackageManager.PERMISSION_GRANTED;
  }

  public void onReceive(Context c, Intent intent) {
    if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())
        || !enabled(c)
        || !Vault.active(c)) return;
    final String connection = Vault.prefs(c).getString("connection", "");
    final PendingResult pending = goAsync();
    new Thread(
            () -> {
              try {
                SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
                if (parts == null || parts.length == 0) return;
                String sender = parts[0].getOriginatingAddress();
                if (!Expense.allowedSender(sender, Vault.prefs(c).getString("smsSenders", "")))
                  return;
                StringBuilder body = new StringBuilder();
                for (SmsMessage part : parts) {
                  if (!java.util.Objects.equals(sender, part.getOriginatingAddress())) return;
                  body.append(part.getMessageBody());
                  if (body.length() > 8000) return;
                }
                JSONObject config = Vault.config(c);
                if (config == null) return;
                Vault.prefs(c)
                    .edit()
                    .putLong("smsEvents", Vault.prefs(c).getLong("smsEvents", 0) + 1)
                    .apply();
                Expense expense = Expense.parseSms(body.toString(), config.getString("package"));
                if (expense == null) {
                  Vault.prefs(c)
                      .edit()
                      .putString(
                          "capture",
                          "SMS получено, но операция не распознана или сообщение отфильтровано")
                      .putLong("skipped", Vault.prefs(c).getLong("skipped", 0) + 1)
                      .apply();
                  return;
                }
                long time = parts[0].getTimestampMillis();
                String raw = "sms\n" + sender + "\n" + time + "\n" + body;
                StringBuilder id = new StringBuilder();
                for (byte b :
                    MessageDigest.getInstance("SHA-256")
                        .digest(raw.getBytes(StandardCharsets.UTF_8)))
                  id.append(String.format("%02x", b & 255));
                JSONObject payload =
                    new JSONObject()
                        .put("eventId", id.toString())
                        .put("package", config.getString("package"))
                        .put("channel", "sms")
                        .put("occurredAt", time)
                        .put(
                            "operation",
                            new JSONObject()
                                .put("kind", expense.kind)
                                .put("amountMinor", expense.amount)
                                .put("currency", expense.currency)
                                .put("merchant", expense.merchant));
                synchronized (Vault.class) {
                  if (!connection.equals(Vault.prefs(c).getString("connection", ""))
                      || !enabled(c)
                      || !Vault.active(c)) return;
                  try (Queue q = new Queue(c)) {
                    q.add(id.toString(), payload);
                  }
                }
                Vault.prefs(c)
                    .edit()
                    .putString("capture", "Операция из SMS распознана и сохранена в очереди")
                    .apply();
                Sender.schedule(c);
              } catch (Exception e) {
                Vault.status(c, "Не удалось обработать SMS. Проверь очередь и свободное место.");
              } finally {
                pending.finish();
              }
            },
            "hecate-sms")
        .start();
  }
}
