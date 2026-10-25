/* STARWAVE sync: progress stays in the player's Google Drive app data folder. */
const starwaveSync = (() => {
  const config = window.STARWAVE_SYNC_CONFIG || {};
  const scope = "https://www.googleapis.com/auth/drive.appdata";
  const fileName = "starwave-progress.json";
  let token = "";
  let expiresAt = 0;
  let user = null;
  let busy = false;
  let connecting = false;
  let waitingForChoice = false;
  let conflictVersion = "";
  let timer = null;
  let failure = "";

  function snapshot(){
    const copy = createBackup().state;
    delete copy.ui;
    delete copy.sync;
    return {format:"STARWAVE_SYNC",version:1,state:copy};
  }

  async function digest(value){
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = await crypto.subtle.digest("SHA-256",bytes);
    return [...new Uint8Array(hash)]
      .map(byte => byte.toString(16).padStart(2,"0")).join("");
  }

  function verify(payload){
    if(payload?.format !== "STARWAVE_SYNC" ||
       payload.version !== 1 ||
       !payload.state || typeof payload.state !== "object" ||
       Array.isArray(payload.state) ||
       !Array.isArray(payload.state.characters)){
      throw new Error("雲端進度格式無法讀取，已保留本機資料。");
    }
    return payload;
  }

  function authorized(){
    return Boolean(token && user && Date.now() < expiresAt - 30000);
  }

  function tokenValid(){
    return Boolean(token && Date.now() < expiresAt - 30000);
  }

  function render(){
    const label = authorized()
      ? `Google Drive · ${state.sync.account || "已連結"}`
      : token && user ? "Google 授權已到期，請重新連結" : "尚未連結";
    $("syncProviderStatus").textContent = failure ||
      (waitingForChoice ? `${label} · 等待選擇進度` : label);
    $("syncLastTime").textContent = state.sync.lastSync || "--";
    $("disconnectSync").disabled = !user || busy;
    $("syncNow").disabled = busy;
    $("connectGoogle").disabled = busy || connecting;
    $("connectGithub").disabled = true;
  }

  async function request(url, options={}){
    if(!tokenValid()) throw new Error("Google 授權已到期，請按「使用 Google 連結」。");
    const response = await fetch(url,{
      ...options,
      headers:{Authorization:`Bearer ${token}`,...(options.headers || {})}
    });
    if(!response.ok){
      if(response.status === 401){
        expiresAt = 0;
        renderSyncSettings();
        throw new Error("Google 授權已到期，請重新連結。");
      }
      let detail = "";
      try{detail = (await response.json()).error?.message || "";}catch{}
      throw new Error(`Google Drive 同步失敗（${response.status}）${detail ? `：${detail}` : ""}`);
    }
    return response;
  }

  async function getRemote(){
    const query = new URLSearchParams({
      spaces:"appDataFolder",
      q:`name = '${fileName}' and trashed = false`,
      fields:"files(id,name,version),nextPageToken",
      pageSize:"10"
    });
    const listing = await (await request(
      `https://www.googleapis.com/drive/v3/files?${query}`
    )).json();
    if(listing.nextPageToken || listing.files?.length > 1){
      throw new Error("雲端出現多份進度檔，請先匯出本機備份再處理。");
    }
    const file = listing.files?.[0];
    if(!file) return null;
    const data = await (await request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`
    )).json();
    verify(data?.payload);
    if(!Number.isSafeInteger(data.revision) || data.revision < 1){
      throw new Error("雲端進度版本無法讀取，已保留本機資料。");
    }
    return {id:file.id,version:String(file.version),revision:data.revision,payload:data.payload};
  }

  async function putRemote(payload, previous){
    const value = JSON.stringify({revision:(previous?.revision || 0)+1,payload});
    if(previous){
      const latest = await getRemote();
      if(!latest || latest.id !== previous.id || latest.version !== previous.version){
        throw new Error("其他裝置剛剛更新了進度，請重新同步。");
      }
      await request(
        `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(previous.id)}?uploadType=media`,
        {method:"PATCH",headers:{"Content-Type":"application/json"},body:value}
      );
    }else{
      if(await getRemote()) throw new Error("其他裝置已建立進度，請重新同步。");
      const boundary = `starwave_${Math.random().toString(36).slice(2)}`;
      const metadata = JSON.stringify({
        name:fileName,mimeType:"application/json",parents:["appDataFolder"]
      });
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        metadata,
        `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        value,
        `\r\n--${boundary}--`
      ]);
      await request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
        {method:"POST",headers:{"Content-Type":`multipart/related; boundary=${boundary}`},body}
      );
    }
    const updated = await getRemote();
    if(!updated || updated.revision !== (previous?.revision || 0)+1){
      throw new Error("無法確認雲端進度，請重新同步。");
    }
    return updated;
  }

  function markSynced(remote, hash){
    state.sync.provider = "Google Drive";
    state.sync.account = user.account;
    state.sync.userId = user.id;
    state.sync.revision = remote.revision;
    state.sync.digest = hash;
    state.sync.lastSync = new Date().toLocaleString("zh-TW");
    failure = "";
    renderSyncSettings();
    scheduleStarwaveSave();
  }

  async function restoreRemote(payload){
    verify(payload);
    const localProfiles = state.api.profiles.map(profile => ({
      provider:profile.provider,
      apiKey:profile.apiKey || ""
    }));
    const remoteState = structuredClone(payload.state);
    delete remoteState.sync;
    delete remoteState.ui;
    if(remoteState.api?.profiles){
      remoteState.api.profiles.forEach((profile,index) => {
        profile.apiKey = localProfiles[index]?.provider === profile.provider
          ? localProfiles[index].apiKey
          : "";
      });
    }
    invalidateRpGenerations();
    mergeSavedState(state,remoteState);
    if(state.currentWavelink && !getRoom(state.currentWavelink)){
      state.currentWavelink = state.wavelinkRooms[0]?.id || null;
    }
    fullRender();
    await saveStarwaveState(state);
  }

  async function choose(mode){
    if(busy || !authorized()) return;
    waitingForChoice = false;
    $("syncConflict").hidden = true;
    busy = true;
    renderSyncSettings();
    try{
      const remote = await getRemote();
      if(!remote || remote.version !== conflictVersion){
        throw new Error("雲端進度已變更，請重新同步後再選擇。");
      }
      if(mode === "cloud"){
        await restoreRemote(remote.payload);
        markSynced(remote,await digest(remote.payload));
      }else{
        const local = snapshot();
        markSynced(await putRemote(local,remote),await digest(local));
      }
      toast("STARWAVE 進度已同步");
    }catch(error){
      failure = "同步失敗";
      showNotice("同步失敗",error.message || "請檢查網路並重試。");
    }finally{
      busy = false;
      renderSyncSettings();
    }
  }

  async function syncNow(manual=false){
    if(!authorized()){
      renderSyncSettings();
      if(manual) showNotice("尚未連結 Google Drive","請先按「使用 Google 連結」。");
      return;
    }
    if(busy || waitingForChoice) return;
    busy = true;
    renderSyncSettings();
    try{
      const local = snapshot();
      const localHash = await digest(local);
      const remote = await getRemote();
      if(!remote){
        markSynced(await putRemote(local,null),localHash);
      }else{
        const remoteHash = await digest(remote.payload);
        const sameAccount = state.sync.userId === user.id &&
          state.sync.provider === "Google Drive";
        if(localHash === remoteHash){
          markSynced(remote,remoteHash);
        }else if(sameAccount && state.sync.digest === remoteHash &&
                 state.sync.revision === remote.revision){
          markSynced(await putRemote(local,remote),localHash);
        }else if(sameAccount && state.sync.digest === localHash){
          await restoreRemote(remote.payload);
          markSynced(remote,remoteHash);
        }else{
          waitingForChoice = true;
          conflictVersion = remote.version;
          $("syncConflict").hidden = false;
          renderSyncSettings();
          return;
        }
      }
      if(manual) toast("STARWAVE 進度已同步");
    }catch(error){
      failure = error.message?.includes("授權已到期")
        ? "Google 授權已到期，請重新連結" : "同步失敗";
      if(manual) showNotice("同步失敗",error.message || "請檢查網路並重試。");
      else console.error("STARWAVE sync failed:",error);
    }finally{
      busy = false;
      renderSyncSettings();
    }
  }

  function connect(){
    if(!config.googleClientId || !window.google?.accounts?.oauth2){
      showNotice("Google 同步尚未設定","請先設定 Google OAuth 用戶端 ID，並確認網頁已載入 Google 登入程式。");
      return;
    }
    if(authorized()){
      showNotice("已連結帳號","若要改用另一個 Google 帳號，請先中斷連結。");
      return;
    }
    if(connecting || busy) return;
    connecting = true;
    renderSyncSettings();
    const client = google.accounts.oauth2.initTokenClient({
      client_id:config.googleClientId,
      scope,
      callback:async response => {
        connecting = false;
        if(!response?.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response,scope)){
          showNotice("Google 連結失敗",response?.error || "未取得雲端資料存取權。");
          renderSyncSettings();
          return;
        }
        token = response.access_token;
        expiresAt = Date.now() + Number(response.expires_in || 3600)*1000;
        try{
          const info = await (await request(
            "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)"
          )).json();
          if(!info.user?.permissionId) throw new Error("無法確認 Google 帳號。");
          user = {
            id:`google:${info.user.permissionId}`,
            account:info.user.emailAddress || "Google 帳號"
          };
          if(state.sync.userId !== user.id || state.sync.provider !== "Google Drive"){
            state.sync.digest = "";
            state.sync.revision = 0;
            state.sync.lastSync = "";
          }
          state.sync.account = user.account;
          failure = "";
          await syncNow(true);
        }catch(error){
          token = "";
          expiresAt = 0;
          user = null;
          showNotice("Google 連結失敗",error.message || "請重試。");
        }
        renderSyncSettings();
      },
      error_callback:() => {
        connecting = false;
        renderSyncSettings();
      }
    });
    client.requestAccessToken({prompt:"select_account"});
  }

  function disconnect(){
    if(!user || busy) return;
    showConfirm({
      title:"中斷跨裝置同步？",
      message:"只解除這台裝置的連結，本機與 Google Drive 進度都不會刪除。",
      okText:"中斷連結",
      onConfirm:() => {
        clearTimeout(timer);
        token = "";
        expiresAt = 0;
        user = null;
        waitingForChoice = false;
        failure = "";
        $("syncConflict").hidden = true;
        state.sync = {provider:null,account:"",lastSync:"",userId:"",revision:0,digest:""};
        renderSyncSettings();
        scheduleStarwaveSave();
        toast("同步連結已中斷");
      }
    });
  }

  function schedule(){
    if(!authorized() || busy || waitingForChoice) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try{
        if(await digest(snapshot()) !== state.sync.digest) await syncNow(false);
      }catch(error){
        console.error("STARWAVE sync scheduling failed:",error);
      }
    },5000);
  }

  async function init(){
    $("connectGoogle").onclick = connect;
    $("connectGithub").onclick = () => showNotice(
      "GitHub 同步尚未開放",
      "GitHub 授權需要獨立設定；目前請使用 Google Drive 或匯出備份。"
    );
    $("syncNow").onclick = () => {
      waitingForChoice = false;
      $("syncConflict").hidden = true;
      syncNow(true);
    };
    $("disconnectSync").onclick = disconnect;
    $("syncKeepCloud").onclick = () => choose("cloud");
    $("syncKeepLocal").onclick = () => choose("local");
    $("syncCancelChoice").onclick = () => {
      waitingForChoice = false;
      $("syncConflict").hidden = true;
      renderSyncSettings();
    };
    document.addEventListener("visibilitychange",() => {
      if(document.visibilityState === "visible") syncNow(false);
    });
    setInterval(() => {
      if(document.visibilityState === "visible") syncNow(false);
    },60000);
    renderSyncSettings();
  }

  return {init,render,schedule,syncNow};
})();
