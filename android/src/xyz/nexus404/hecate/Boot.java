package xyz.nexus404.hecate;

import android.content.*;

public final class Boot extends BroadcastReceiver {
  public void onReceive(Context c, Intent i) {
    Vault.retireExtras(c);
    Sender.schedule(c);
    BandUpload.schedule(c, false);
    BandService.resume(c);
  }
}
