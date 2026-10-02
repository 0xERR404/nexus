package xyz.nexus404.hecate;

import android.content.*;
import android.media.*;
import android.media.session.*;
import java.util.*;

final class BandMedia {
  static boolean enabled(Context c) {
    return Vault.prefs(c).getBoolean("bandMediaEnabled", false);
  }

  static final class Watch {
    private final Context context;
    private final Runnable changed;
    private final android.os.Handler handler;
    private final MediaSessionManager manager;
    private final Map<MediaSession.Token, MediaController> observed = new HashMap<>();
    private boolean registered;

    Watch(Context c, android.os.Handler h, Runnable update) {
      context = c;
      handler = h;
      changed = update;
      manager = (MediaSessionManager) c.getSystemService(Context.MEDIA_SESSION_SERVICE);
    }

    private final MediaController.Callback callback =
        new MediaController.Callback() {
          public void onMetadataChanged(MediaMetadata m) {
            changed.run();
          }

          public void onPlaybackStateChanged(PlaybackState s) {
            changed.run();
          }

          public void onAudioInfoChanged(MediaController.PlaybackInfo p) {
            changed.run();
          }

          public void onSessionDestroyed() {
            refresh();
          }
        };
    private final MediaSessionManager.OnActiveSessionsChangedListener listener =
        list -> select(list);

    private void select(List<MediaController> list) {
      Set<MediaSession.Token> live = new HashSet<>();
      if (list != null)
        for (MediaController player : list) {
          MediaSession.Token token = player.getSessionToken();
          live.add(token);
          if (!observed.containsKey(token)) {
            player.registerCallback(callback, handler);
            observed.put(token, player);
          }
        }
      Iterator<Map.Entry<MediaSession.Token, MediaController>> it = observed.entrySet().iterator();
      while (it.hasNext()) {
        Map.Entry<MediaSession.Token, MediaController> entry = it.next();
        if (!live.contains(entry.getKey())) {
          entry.getValue().unregisterCallback(callback);
          it.remove();
        }
      }
      changed.run();
    }

    void refresh() {
      if (!enabled(context)) {
        close();
        return;
      }
      try {
        ComponentName source = new ComponentName(context, BankListener.class);
        if (!registered) {
          manager.addOnActiveSessionsChangedListener(listener, source, handler);
          registered = true;
        }
        select(manager.getActiveSessions(source));
      } catch (SecurityException e) {
        close();
        Vault.prefs(context)
            .edit()
            .putString("bandMediaStatus", "Разреши Гекате доступ к уведомлениям Android")
            .apply();
      }
    }

    void close() {
      for (MediaController player : observed.values()) player.unregisterCallback(callback);
      observed.clear();
      if (registered) {
        manager.removeOnActiveSessionsChangedListener(listener);
        registered = false;
      }
    }
  }

  static String diagnostic(Context c) {
    if (!enabled(c)) return "Управление плеером выключено";
    try {
      MediaController player = current(c);
      if (player == null)
        return "Доступ Android есть · активный плеер не найден. Запусти музыку на телефоне";
      BandService service = BandService.instance;
      if (service == null) return "Плеер найден · служба Bluetooth не запущена";
      return "Плеер Android найден · " + BandService.linkState(c);
    } catch (SecurityException ex) {
      return "Android запретил доступ к медиасессиям. Разреши Гекате доступ к уведомлениям";
    }
  }

  static void settings(BandActivity a, android.widget.LinearLayout parent) {
    android.widget.LinearLayout panel = new android.widget.LinearLayout(a);
    panel.setOrientation(1);
    parent.addView(panel);
    android.widget.CheckBox enable = new android.widget.CheckBox(a);
    enable.setText("Управлять плеером телефона с браслета");
    enable.setTextColor(0xffd5dde8);
    enable.setChecked(enabled(a));
    panel.addView(enable);
    enable.setOnCheckedChangeListener(
        (v, on) -> {
          Vault.prefs(a).edit().putBoolean("bandMediaEnabled", on).apply();
          BandService service = BandService.instance;
          if (service != null) service.refreshMediaBridge();
          if (on)
            android.service.notification.NotificationListenerService.requestRebind(
                new ComponentName(a, BankListener.class));
        });
    a.button(
        panel,
        "Плеер · разрешить доступ Android",
        () -> {
          try {
            a.startActivity(
                new Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
          } catch (RuntimeException ex) {
            a.note("Открой Android → Специальный доступ → Доступ к уведомлениям → Геката");
          }
        });
    a.button(
        panel,
        "Проверить и передать плеер на браслет",
        () -> {
          a.note(diagnostic(a));
          BandService service = BandService.instance;
          if (service != null) service.testMedia();
        });
  }

  static MediaController choose(Context c, List<MediaController> list) {
    if (list == null || list.isEmpty()) return null;
    String last = Vault.prefs(c).getString("bandLastPlayer", "");
    int[] states = new int[list.size()];
    String[] packages = new String[list.size()];
    for (int i = 0; i < list.size(); i++) {
      PlaybackState state = list.get(i).getPlaybackState();
      states[i] = state == null ? 0 : state.getState();
      packages[i] = list.get(i).getPackageName();
    }
    MediaController chosen = list.get(BandPolicy.player(states, packages, last));
    PlaybackState state = chosen.getPlaybackState();
    if (state != null
        && state.getState() == PlaybackState.STATE_PLAYING
        && !chosen.getPackageName().equals(last))
      Vault.prefs(c).edit().putString("bandLastPlayer", chosen.getPackageName()).apply();
    return chosen;
  }

  static MediaController current(Context c) {
    return choose(
        c,
        ((MediaSessionManager) c.getSystemService(Context.MEDIA_SESSION_SERVICE))
            .getActiveSessions(new ComponentName(c, BankListener.class)));
  }

  static boolean mediaKey(Context c, MediaController player, int code) {
    long now = android.os.SystemClock.uptimeMillis();
    android.view.KeyEvent
        down = new android.view.KeyEvent(now, now, android.view.KeyEvent.ACTION_DOWN, code, 0),
        up = new android.view.KeyEvent(now, now, android.view.KeyEvent.ACTION_UP, code, 0);
    if (player != null) {
      boolean accepted = player.dispatchMediaButtonEvent(down);
      player.dispatchMediaButtonEvent(up);
      return accepted;
    }
    AudioManager audio = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
    if (audio == null) return false;
    audio.dispatchMediaKeyEvent(down);
    audio.dispatchMediaKeyEvent(up);
    Vault.prefs(c)
        .edit()
        .putString("bandMediaStatus", "Команда запуска передана Android · ожидаем плеер")
        .apply();
    return true;
  }

  static boolean control(Context c, Map<Integer, byte[]> fields) {
    int button = BandProtocol.number(fields, 1), volume = BandProtocol.number(fields, 2);
    MediaController player = current(c);
    if (player == null)
      return button == 1 && mediaKey(c, null, android.view.KeyEvent.KEYCODE_MEDIA_PLAY);
    MediaController.TransportControls controls = player.getTransportControls();
    PlaybackState playback = player.getPlaybackState();
    long actions = playback == null ? 0 : playback.getActions();
    boolean handled = false;
    if (button >= 1 && button <= 4) {
      long[] supported = {
        PlaybackState.ACTION_PLAY,
        PlaybackState.ACTION_PAUSE,
        PlaybackState.ACTION_SKIP_TO_PREVIOUS,
        PlaybackState.ACTION_SKIP_TO_NEXT
      };
      int[] keys = {
        android.view.KeyEvent.KEYCODE_MEDIA_PLAY,
        android.view.KeyEvent.KEYCODE_MEDIA_PAUSE,
        android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS,
        android.view.KeyEvent.KEYCODE_MEDIA_NEXT
      };
      if ((actions & supported[button - 1]) != 0) {
        if (button == 1) controls.play();
        else if (button == 2) controls.pause();
        else if (button == 3) controls.skipToPrevious();
        else controls.skipToNext();
        handled = true;
      } else handled = mediaKey(c, player, keys[button - 1]);
    } else if (button == 5 || button == 6) {
      player.adjustVolume(button == 5 ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER, 0);
      handled = true;
    }
    MediaController.PlaybackInfo info = player.getPlaybackInfo();
    if (volume >= 0 && info != null && volume <= info.getMaxVolume()) {
      player.setVolumeTo(volume, 0);
      handled = true;
    }
    return handled;
  }

  static byte[] info(Context c) {
    MediaController player = current(c);
    MediaMetadata m = player == null ? null : player.getMetadata();
    PlaybackState state = player == null ? null : player.getPlaybackState();
    MediaController.PlaybackInfo volume = player == null ? null : player.getPlaybackInfo();
    return BandAuth.tlv(
        1,
        BandAuth.utf(
            BandNotices.trim(m == null ? "" : m.getString(MediaMetadata.METADATA_KEY_ARTIST), 96)),
        2,
        BandAuth.utf(
            BandNotices.trim(
                m == null
                    ? "Последний плеер · нажми ▶"
                    : m.getString(MediaMetadata.METADATA_KEY_TITLE),
                192)),
        3,
        new byte[] {(byte) (state == null ? 0 : state.getState())},
        4,
        new byte[] {(byte) (volume == null ? 0 : Math.min(255, volume.getMaxVolume()))},
        5,
        new byte[] {(byte) (volume == null ? 0 : Math.min(255, volume.getCurrentVolume()))});
  }
}
