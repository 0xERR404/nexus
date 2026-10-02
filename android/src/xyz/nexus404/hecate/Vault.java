package xyz.nexus404.hecate;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class Vault {
  static final String ALIAS = "nexus404.hecate.v1";

  static String version(Context context) {
    try {
      return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
    } catch (android.content.pm.PackageManager.NameNotFoundException e) {
      return "?";
    }
  }

  static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences("hecate", Context.MODE_PRIVATE);
  }

  static synchronized SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
    KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    gen.init(
        new KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
    return gen.generateKey();
  }

  static String seal(String value) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
        + ":"
        + Base64.encodeToString(
            cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
  }

  static String open(String value) throws Exception {
    String[] parts = value.split(":", 2);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(
        Cipher.DECRYPT_MODE,
        key(),
        new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
    return new String(
        cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
  }

  static void retireExtras(Context c) {
    android.app.job.JobScheduler jobs =
        (android.app.job.JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
    for (int id : new int[] {3, 4, 6, 7, 8, 9, 10}) jobs.cancel(id);
    if (prefs(c).getBoolean("extrasRetired36", false)) return;
    for (android.content.UriPermission grant : c.getContentResolver().getPersistedUriPermissions())
      try {
        c.getContentResolver()
            .releasePersistableUriPermission(
                grant.getUri(),
                (grant.isReadPermission() ? 1 : 0) | (grant.isWritePermission() ? 2 : 0));
      } catch (RuntimeException ignored) {
      }
    SharedPreferences.Editor edit = prefs(c).edit();
    for (String name : prefs(c).getAll().keySet())
      if (name.startsWith("health")
          || name.startsWith("hc")
          || name.startsWith("folder")
          || name.startsWith("hermes")
          || name.startsWith("music")) edit.remove(name);
    android.app.NotificationManager notices =
        (android.app.NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
    for (String channel : new String[] {"hermes-events", "hermes-service", "apollo"})
      notices.deleteNotificationChannel(channel);
    edit.putBoolean("extrasRetired36", true).putBoolean("bandSystemPair", true).commit();
    java.io.File[] files = c.getCacheDir().listFiles();
    if (files != null)
      for (java.io.File file : files)
        if (file.getName().matches("(?:health-.*\\.db|apollo-.*\\.cache|folders-.*\\.upload)"))
          file.delete();
  }

  static JSONObject config(Context c) throws Exception {
    String value = prefs(c).getString("connection", "");
    return value.isEmpty() ? null : new JSONObject(open(value));
  }

  static void status(Context c, String message) {
    AppDiagnostics.event(c,"Банк",message);
    prefs(c).edit().putString("status", message).apply();
  }

  static boolean active(Context c) {
    return prefs(c).getBoolean("enabled", false);
  }
}
