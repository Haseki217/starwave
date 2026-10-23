/* STARWAVE account sync. The publishable key is configured in sync-config.js. */
const starwaveSync = (() => {
  const config = window.STARWAVE_SYNC_CONFIG || {};
  const ready = Boolean(config.url && config.publishableKey && window.supabase?.createClient);
  const client = ready
    ? window.supabase.createClient(config.url, config.publishableKey)
    : null;
  let sessionUser = null;
  let busy = false;
  let waitingForChoice = false;
  let conflictRevision = 0;
  let timer = null;
  let failure = "";

  function snapshot(){
    const copy = createBackup().state;
    delete copy.ui;
    delete copy.sync;
    return {format:"STARWAVE_SYNC", version:1, state:copy};
  }

  async function digest(value){
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
      .map(byte => byte.toString(16).padStart(2,"0")).join("");
  }

  function verify(payload){
    if(payload?.format !== "STARWAVE_SYNC" ||
       payload.version !== 1 ||
       !payload.state ||
       typeof payload.state !== "object" ||
       Array.isArray(payload.state) ||
       !Array.isArray(payload.state.characters)){
      throw new Error("雲端進度格式無法讀取，已保留本機資料。");
    }
    return payload;
  }

  function markSynced(revision, hash){
    state.sync.revision = revision;
    state.sync.digest = hash;
    state.sync.userId = sessionUser.id;
    state.sync.lastSync = new Date().toLocaleString("zh-TW");
    failure = "";
    renderSyncSettings();
    scheduleStarwaveSave();
  }

  function render(){
    const label = sessionUser
      ? `${state.sync.provider}${state.sync.account ? ` · ${state.sync.account}` : ""}`
      : "尚未連結";
    $("syncProviderStatus").textContent = failure ||
      (waitingForChoice ? `${label} · 等待選擇進度` : label);
    $("syncLastTime").textContent = state.sync.lastSync || "--";
    $("disconnectSync").disabled = !sessionUser || busy;
    $("syncNow").disabled = !sessionUser || busy;
    $("connectGoogle").disabled = busy;
    $("connectGithub").disabled = busy;
  }

  async function getRemote(){
    const {data,error} = await client.from("starwave_sync")
      .select("revision,payload")
      .eq("user_id",sessionUser.id).maybeSingle();
    if(error) throw error;
    if(data) verify(data.payload);
    return data;
  }

  async function putRemote(payload, previous){
    let result;
    if(previous){
      result = await client.from("starwave_sync")
        .update({payload,revision:previous.revision+1,updated_at:new Date().toISOString()})
        .eq("user_id",sessionUser.id)
        .eq("revision",previous.revision)
        .select("revision").maybeSingle();
    }else{
      result = await client.from("starwave_sync")
        .insert({user_id:sessionUser.id,payload,revision:1})
        .select("revision").single();
    }
    if(result.error){
      if(result.error.code === "23505") throw new Error("另一台裝置已先建立進度，請重新同步。");
      throw result.error;
    }
    if(!result.data) throw new Error("雲端進度已在其他裝置變更，請重新同步。");
    return result.data.revision;
  }

  async function restoreRemote(payload){
    verify(payload);
    const keys = state.api.profiles.map(profile => profile.apiKey || "");
    const remoteState = structuredClone(payload.state);
    delete remoteState.sync;
    delete remoteState.ui;
    if(remoteState.api?.profiles){
      remoteState.api.profiles.forEach((profile,index) => {
        profile.apiKey = keys[index] || "";
      });
    }
    mergeSavedState(state,remoteState);
    if(state.currentWavelink && !getRoom(state.currentWavelink)){
      state.currentWavelink = state.wavelinkRooms[0]?.id || null;
    }
    fullRender();
    await saveStarwaveState(state);
  }

  async function choose(mode){
    if(busy || !sessionUser) return;
    waitingForChoice = false;
    $("syncConflict").hidden = true;
    busy = true;
    renderSyncSettings();
    try{
      const remote = await getRemote();
      if(!remote) throw new Error("雲端進度已變更，請重新同步。");
      if(remote.revision !== conflictRevision){
        throw new Error("雲端進度剛剛又有變更，請重新同步後再選擇。");
      }
      if(mode === "cloud"){
        await restoreRemote(remote.payload);
        markSynced(remote.revision,await digest(remote.payload));
      }else{
        const local = snapshot();
        const revision = await putRemote(local,remote);
        markSynced(revision,await digest(local));
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
    if(!client || !sessionUser || busy || waitingForChoice) return;
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
        const sameAccount = state.sync.userId === sessionUser.id;
        if(localHash === remoteHash){
          markSynced(remote.revision,remoteHash);
        }else if(sameAccount && state.sync.digest === remoteHash &&
                 state.sync.revision === remote.revision){
          markSynced(await putRemote(local,remote),localHash);
        }else if(sameAccount && state.sync.digest === localHash){
          await restoreRemote(remote.payload);
          markSynced(remote.revision,remoteHash);
        }else{
          waitingForChoice = true;
          conflictRevision = remote.revision;
          $("syncConflict").hidden = false;
          renderSyncSettings();
          return;
        }
      }
      if(manual) toast("STARWAVE 進度已同步");
    }catch(error){
      failure = "同步失敗";
      if(manual) showNotice("同步失敗",error.message || "請檢查網路並重試。");
      else console.error("STARWAVE sync failed:",error);
    }finally{
      busy = false;
      renderSyncSettings();
    }
  }

  async function connect(provider){
    if(!client){
      showNotice("尚未設定同步服務","請先完成 STARWAVE 雲端同步的專案設定。");
      return;
    }
    if(sessionUser){
      showNotice("已連結帳號","請先中斷目前帳號，再連結其他帳號。");
      return;
    }
    const {error} = await client.auth.signInWithOAuth({
      provider,
      options:{redirectTo:location.origin+location.pathname}
    });
    if(error) showNotice("登入失敗",error.message);
  }

  async function disconnect(){
    if(!sessionUser || busy) return;
    showConfirm({
      title:"中斷跨裝置同步？",
      message:"只解除這台裝置的連結，本機與雲端進度都不會刪除。",
      okText:"中斷連結",
      onConfirm:async () => {
        clearTimeout(timer);
        const {error} = await client.auth.signOut({scope:"local"});
        if(error){showNotice("中斷失敗",error.message);return;}
        sessionUser = null;
        waitingForChoice = false;
        $("syncConflict").hidden = true;
        state.sync = {provider:null,account:"",lastSync:"",userId:"",revision:0,digest:""};
        renderSyncSettings();
        scheduleStarwaveSave();
        toast("同步連結已中斷");
      }
    });
  }

  function schedule(){
    if(!sessionUser || busy || waitingForChoice || !client) return;
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
    $("connectGoogle").onclick = () => connect("google");
    $("connectGithub").onclick = () => connect("github");
    $("syncNow").onclick = () => {
      waitingForChoice = false;
      $("syncConflict").hidden = true;
      if(!sessionUser) showNotice("尚未連結同步帳號","請先使用 Google 或 GitHub 連結。");
      else syncNow(true);
    };
    $("disconnectSync").onclick = disconnect;
    $("syncKeepCloud").onclick = () => choose("cloud");
    $("syncKeepLocal").onclick = () => choose("local");
    $("syncCancelChoice").onclick = () => {
      $("syncConflict").hidden = true;
      renderSyncSettings();
    };
    if(!client){renderSyncSettings();return;}
    const {data,error} = await client.auth.getUser();
    if(error && error.name !== "AuthSessionMissingError"){
      failure = "登入狀態無法確認";
      console.error("STARWAVE sync auth failed:",error);
    }
    sessionUser = data?.user || null;
    if(sessionUser){
      const provider = sessionUser.app_metadata?.provider || "";
      if(state.sync.userId !== sessionUser.id){
        state.sync.digest = "";
        state.sync.revision = 0;
        state.sync.lastSync = "";
      }
      state.sync.userId = sessionUser.id;
      state.sync.provider = provider === "google" ? "Google" : provider === "github" ? "GitHub" : provider;
      state.sync.account = sessionUser.user_metadata?.user_name || sessionUser.email || "";
      renderSyncSettings();
      await syncNow(false);
    }else{
      state.sync.provider = null;
      state.sync.account = "";
      renderSyncSettings();
    }
    client.auth.onAuthStateChange((event) => {
      if(event === "SIGNED_OUT"){
        sessionUser = null;
        state.sync.provider = null;
        state.sync.account = "";
        renderSyncSettings();
      }
    });
    document.addEventListener("visibilitychange",() => {
      if(document.visibilityState === "visible") syncNow(false);
    });
    setInterval(() => {
      if(document.visibilityState === "visible") syncNow(false);
    },60000);
  }

  return {init,render,schedule,syncNow};
})();
