package xyz.nexus404.hecate;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.widget.TextView;
import org.json.JSONObject;

final class AppUpdate {
  private HubHttp.Call call;
  private String download;
  private final Activity activity;
  private final TextView status;

  AppUpdate(Activity activity, TextView status) {
    this.activity = activity;
    this.status = status;
  }

  static boolean newer(JSONObject available, long installed) {
    return available != null
        && available.optLong("code", -1) > installed
        && available.optString("version").matches("[0-9]+\\.[0-9]+\\.[0-9]+")
        && available.optString("sha256").matches("[a-f0-9]{64}");
  }

  void check() {
    if (call != null) return;
    HubHttp.Call task = new HubHttp.Call();
    call = task;
    status.setText("Проверка версии на хабе…");
    download = null;
    new Thread(() -> {
      String message, url = null;
      try {
        JSONObject cfg = BandUpload.config(activity);
        boolean band = cfg != null;
        if (!band) cfg = Vault.config(activity);
        if (cfg == null) throw new IllegalStateException();
        HubHttp.Result result = task.post(
            cfg,
            band ? "/api/rhythm/sync" : "/api/balance/notifications",
            new JSONObject().put("type", "hello"));
        if (result.code != 200 || !"ready".equals(result.body.optString("state")))
          throw new IllegalStateException();
        JSONObject available = result.body.optJSONObject("companion");
        long installed = activity.getPackageManager()
            .getPackageInfo(activity.getPackageName(), 0).versionCode;
        if (newer(available, installed)) {
          url = cfg.getString("origin") + "/modules/balance/companion.apk";
          message = "Установлена " + Vault.version(activity)
              + " · на хабе " + available.getString("version")
              + "\nНажми «Скачать обновление». Может понадобиться вход в хаб; установку подтверждает Android.";
        } else {
          message = available == null
              ? "Хаб не сообщает версию APK · обнови сервер"
              : "Установлена " + Vault.version(activity) + " · на хабе "
                  + available.optString("version") + " · новой версии нет";
        }
      } catch (Exception e) {
        message = "Не удалось проверить обновление. Проверь подключение хаба и сеть.";
      }
      final String text = message, target = url;
      activity.runOnUiThread(() -> {
        if (!task.stopped && !activity.isDestroyed()) {
          AppDiagnostics.event(activity,"Обновление APK",text);
          status.setText(text);
          download = target;
        }
        if (call == task) call = null;
      });
    }, "hecate-update").start();
  }

  void download() {
    if (download == null) {
      check();
      return;
    }
    try {
      activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(download)));
    } catch (RuntimeException e) {
      status.setText("Не найден браузер для скачивания APK");
    }
  }

  void stop() {
    if (call != null) call.cancel();
    call = null;
  }
}
