"use strict";
const path = require("path");
const electron = require("electron");
const unusedFilename = require("unused-filename");
const pupa = require("pupa");
const extName = require("ext-name");

const { app, shell } = electron;

function getFilenameFromMime(name, mime) {
  const exts = extName.mime(mime);

  if (exts.length !== 1) {
    return name;
  }

  return `${name}.${exts[0].ext}`;
}

function registerListener(session, options, cb = () => {}) {
  const downloadItems = new Set();
  let receivedBytes = 0;
  let completedBytes = 0;
  let totalBytes = 0;
  let startTime = new Date().getTime();

  const activeDownloadItems = () => downloadItems.size;
  const progressDownloadItems = detailedProgress => {
    if (detailedProgress) {
      const nowTime = new Date().getTime();
      const duration = (nowTime - startTime) / 1000;
      const speed = Math.floor((receivedBytes * 8) / duration); // in bps
      // convert speed to kbps (speed / 1024).toFixed(2)

      return {
        s: speed,
        p: receivedBytes / totalBytes,
        t: totalBytes,
        r: receivedBytes
      };
    } else {
      return receivedBytes / totalBytes;
    }
  };

  options = Object.assign(
    {
      showBadge: true
    },
    options
  );

  const listener = (e, item, webContents) => {
    downloadItems.add(item);
    totalBytes += item.getTotalBytes();

    let hostWebContents = webContents;
    if (webContents.getType() === "webview") {
      ({ hostWebContents } = webContents);
    }
    const win = electron.BrowserWindow.fromWebContents(hostWebContents);

    const dir = options.directory || app.getPath("downloads");
    let filePath;
    if (options.filename) {
      filePath = path.join(dir, options.filename);
    } else {
      const filename = item.getFilename();
      const name = path.extname(filename)
        ? filename
        : getFilenameFromMime(filename, item.getMimeType());

      filePath = unusedFilename.sync(path.join(dir, name));
    }

    const errorMessage =
      options.errorMessage || "The download of {filename} was interrupted";
    const errorTitle = options.errorTitle || "Download Error";
    const showErrorDialog =
      options.showErrorDialog != null ? options.showErrorDialog : true; // default is true
    const showProgressBar =
      options.showProgressBar != null ? options.showProgressBar : false; // default is false
    const detailedProgress =
      options.detailedProgress != null ? options.detailedProgress : false; // default is false

    if (!options.saveAs) {
      item.setSavePath(filePath);
    }

    if (typeof options.onStarted === "function") {
      options.onStarted(item);
    }

    item.on("updated", () => {
      receivedBytes = [...downloadItems].reduce((receivedBytes, item) => {
        receivedBytes += item.getReceivedBytes();
        return receivedBytes;
      }, completedBytes);

      if (options.showBadge && ["darwin", "linux"].includes(process.platform)) {
        app.setBadgeCount(activeDownloadItems());
      }

      if (!win.isDestroyed() && showProgressBar) {
        win.setProgressBar(receivedBytes / totalBytes);
      }

      if (typeof options.onProgress === "function") {
        options.onProgress(progressDownloadItems(detailedProgress));
      }
    });

    item.on("done", (e, state) => {
      completedBytes += item.getTotalBytes();
      downloadItems.delete(item);

      if (options.showBadge && ["darwin", "linux"].includes(process.platform)) {
        app.setBadgeCount(activeDownloadItems());
      }

      if (!win.isDestroyed() && !activeDownloadItems()) {
        if (showProgressBar) {
          win.setProgressBar(-1);
        }
        receivedBytes = 0;
        completedBytes = 0;
        totalBytes = 0;
      }

      if (options.unregisterWhenDone) {
        session.removeListener("will-download", listener);
      }

      if (state === "cancelled") {
        if (typeof options.onCancel === "function") {
          options.onCancel(item);
        }
      } else if (state === "interrupted") {
        const message = pupa(errorMessage, { filename: item.getFilename() });
        if (showErrorDialog) {
          electron.dialog.showErrorBox(errorTitle, message);
        }
        cb(new Error(message));
      } else if (state === "completed") {
        if (process.platform === "darwin") {
          app.dock.downloadFinished(filePath);
        }

        if (options.openFolderWhenDone) {
          shell.showItemInFolder(path.join(dir, item.getFilename()));
        }

        cb(null, item);
      }
    });
  };

  session.on("will-download", listener);
}

module.exports = (options = {}) => {
  app.on("session-created", session => {
    registerListener(session, options);
  });
};

module.exports.download = (win, url, options) =>
  new Promise((resolve, reject) => {
    options = Object.assign({}, options, { unregisterWhenDone: true });

    registerListener(win.webContents.session, options, (err, item) => {
      if (err) {
        reject(err);
      } else {
        resolve(item);
      }
    });

    win.webContents.downloadURL(url);
  });
