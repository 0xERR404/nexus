package xyz.nexus404.hecate;

import android.app.Notification;
import android.content.*;
import android.content.pm.ResolveInfo;
import android.os.SystemClock;
import android.service.notification.*;
import android.widget.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

final class BandNotices {
  static final String ENABLED = "bandNoticesEnabled",
      APPS = "bandNoticeApps",
      STATUS = "bandNoticeStatus";
  static final long TTL = 120000;

  static final class Item {
    final String key, app, title, body;
    final long time;

    Item(String key, String app, String title, String body) {
      this.key = key;
      this.app = app;
      this.title = title;
      this.body = body;
      time = SystemClock.elapsedRealtime();
    }
  }

  static boolean enabled(Context c) {
    return Vault.prefs(c).getBoolean(ENABLED, false);
  }

  static void status(Context c, String s) {
    if(!s.equals(Vault.prefs(c).getString(STATUS,"")))AppDiagnostics.event(c,"Уведомления",s);
    Vault.prefs(c).edit().putString(STATUS, s).apply();
  }

  static String trim(String text, int bytes) {
    if (text == null) return "";
    StringBuilder s = new StringBuilder();
    int size = 0;
    for (int i = 0; i < text.length(); ) {
      int cp = text.codePointAt(i);
      i += Character.charCount(cp);
      if (Character.isISOControl(cp) && cp != '\n') continue;
      String ch = new String(Character.toChars(cp));
      int n = ch.getBytes(StandardCharsets.UTF_8).length;
      if (size + n > bytes) break;
      s.append(ch);
      size += n;
    }
    return s.toString();
  }

  static byte[] packet(int id, String app, String title, String body) {
    return packet(id, app, title, body, 384);
  }

  static byte[] packet(int id, String app, String title, String body, int limit) {
    byte[] entries =
        BandAuth.tlv(
            141,
            BandAuth.tlv(
                14,
                new byte[] {3},
                15,
                new byte[] {2},
                16,
                BandAuth.utf(trim(title, Math.min(96, limit)))),
            141,
            BandAuth.tlv(
                14,
                new byte[] {1},
                15,
                new byte[] {2},
                16,
                BandAuth.utf(trim(body, Math.min(384, limit)))));
    return BandAuth.tlv(
        1,
        new byte[] {(byte) (id >> 8), (byte) id},
        2,
        new byte[] {127},
        3,
        new byte[] {1},
        132,
        BandAuth.tlv(140, entries),
        17,
        BandAuth.utf(trim(app, 127)));
  }

  static int contentLimit(Map<Integer, byte[]> fields) {
    try {
      byte[] a = fields.get(129);
      a = BandProtocol.parseTlv(a).get(130);
      a = BandProtocol.parseTlv(a).get(144);
      for (byte[] entry : BandProtocol.values(a, 145)) {
        Map<Integer, byte[]> item = BandProtocol.parseTlv(entry);
        if (BandProtocol.number(item, 18) != 1) continue;
        byte[] size = item.get(20);
        if (size == null || (size.length != 1 && size.length != 2 && size.length != 4)) continue;
        long n = 0;
        for (byte b : size) n = (n << 8) | (b & 255);
        if (n > 0) return (int) Math.min(n, 384);
      }
    } catch (RuntimeException ignored) {
    }
    return 15;
  }

  static void capture(Context c, StatusBarNotification sbn) {
    if (!enabled(c)
        || sbn == null
        || !Vault.prefs(c)
            .getStringSet(APPS, Collections.emptySet())
            .contains(sbn.getPackageName())) return;
    Notification n = sbn.getNotification();
    if (n == null
        || n.extras == null
        || (n.flags & (Notification.FLAG_GROUP_SUMMARY | Notification.FLAG_ONGOING_EVENT)) != 0)
      return;
    if (c.getPackageName().equals(sbn.getPackageName())) return;
    long age = System.currentTimeMillis() - sbn.getPostTime();
    if (age > TTL || age < -60000) return;
    CharSequence title = n.extras.getCharSequence(Notification.EXTRA_TITLE, "");
    CharSequence body = n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
    if (body == null || body.length() == 0)
      body = n.extras.getCharSequence(Notification.EXTRA_TEXT, "");
    if (body == null || body.length() == 0) {
      CharSequence[] lines = n.extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
      if (lines != null) body = android.text.TextUtils.join("\n", lines);
    }
    String t = trim(title == null ? "" : title.toString(), 96),
        b = trim(body == null ? "" : body.toString(), 384);
    if (t.isEmpty() && b.isEmpty()) return;
    BandService s = BandService.instance;
    if (s == null) {
      status(c, "Нет связи с браслетом · уведомление не отправлено");
      return;
    }
    s.offerNotice(new Item(sbn.getKey(), sbn.getPackageName(), t, b), false);
  }

  static void settings(BandActivity a, LinearLayout parent) {
    LinearLayout panel = new LinearLayout(a);
    panel.setOrientation(1);
    panel.setVisibility(android.view.View.GONE);
    a.button(
        parent,
        "Уведомления на браслете",
        () ->
            panel.setVisibility(
                panel.getVisibility() == android.view.View.GONE
                    ? android.view.View.VISIBLE
                    : android.view.View.GONE));
    parent.addView(panel);
    TextView info = new TextView(a);
    info.setText("Только текст выбранных приложений, без сохранения в хабе.");
    info.setTextColor(0xffb8c4d3);
    info.setTextSize(12);
    panel.addView(info);
    CheckBox enable = new CheckBox(a);
    enable.setText("Пересылать уведомления");
    enable.setTextColor(0xffd5dde8);
    enable.setChecked(enabled(a));
    panel.addView(enable);
    enable.setOnCheckedChangeListener(
        (v, on) -> {
          Vault.prefs(a).edit().putBoolean(ENABLED, on).apply();
          BandService s = BandService.instance;
          if (s != null) s.noticePreferencesChanged();
          if (on)
            NotificationListenerService.requestRebind(new ComponentName(a, BankListener.class));
        });
    a.button(
        panel,
        "Разрешить доступ к уведомлениям",
        () -> {
          try {
            a.startActivity(
                new Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
          } catch (RuntimeException e) {
            status(a, "Открой настройки Android → Доступ к уведомлениям → Геката");
          }
        });
    a.button(
        panel,
        "Тест на браслет",
        () -> {
          BandService s = BandService.instance;
          if (!enabled(a)) {
            status(a, "Сначала включи пересылку");
            return;
          }
          if (s == null) {
            status(a, "Сначала подключи браслет");
            return;
          }
          s.offerNotice(
              new Item("test", a.getPackageName(), "Геката", "Bluetooth-уведомления · проверка"),
              true);
        });
    LinearLayout apps = new LinearLayout(a);
    apps.setOrientation(1);
    apps.setVisibility(android.view.View.GONE);
    panel.addView(apps);
    a.button(
        panel,
        "Выбрать приложения",
        () -> {
          if (apps.getChildCount() == 0) {
            Intent launch = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> list = a.getPackageManager().queryIntentActivities(launch, 0);
            list.sort(
                (x, y) ->
                    x.loadLabel(a.getPackageManager())
                        .toString()
                        .compareToIgnoreCase(y.loadLabel(a.getPackageManager()).toString()));
            Set<String> added = new HashSet<>();
            for (ResolveInfo app : list) {
              String pkg = app.activityInfo.packageName;
              if (pkg.equals(a.getPackageName()) || !added.add(pkg)) continue;
              CheckBox box = new CheckBox(a);
              box.setText(app.loadLabel(a.getPackageManager()));
              box.setTextColor(0xffd5dde8);
              box.setTextSize(13);
              box.setChecked(
                  Vault.prefs(a).getStringSet(APPS, Collections.emptySet()).contains(pkg));
              apps.addView(box);
              box.setOnCheckedChangeListener(
                  (v, on) -> {
                    Set<String> selected =
                        new HashSet<>(Vault.prefs(a).getStringSet(APPS, Collections.emptySet()));
                    if (on) selected.add(pkg);
                    else selected.remove(pkg);
                    Vault.prefs(a).edit().putStringSet(APPS, selected).apply();
                    BandService s = BandService.instance;
                    if (s != null) s.noticePreferencesChanged();
                  });
            }
          }
          apps.setVisibility(
              apps.getVisibility() == android.view.View.GONE
                  ? android.view.View.VISIBLE
                  : android.view.View.GONE);
        });
  }
}
