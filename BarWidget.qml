import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "kelmankenberg.appdeck"

  property bool popupOpen: false
  property string phoneUrl: ""
  property string pairingCode: ""
  property string qrFile: ""
  property string serviceError: ""
  property bool phoneConnected: false

  readonly property bool opened: popupOpen

  function open() { popupOpen = true }
  function close() { popupOpen = false }
  function togglePanel() { popupOpen = !popupOpen }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Process {
    id: server
    command: ["python3", Qt.resolvedUrl("appdeck_server.py").toString().replace(/^file:\/\//, "")]
    running: true

    stdout: SplitParser {
      onRead: function(line) {
        try {
          var info = JSON.parse(String(line))
          if (info.type === "phone-status") {
            root.phoneConnected = info.connected === true
            return
          }
          root.phoneUrl = String(info.url || "")
          root.pairingCode = String(info.pairingCode || "")
          root.qrFile = String(info.qrFile || "")
          root.serviceError = ""
        } catch (error) {
          root.serviceError = "App Deck could not read its service status."
        }
      }
    }

    stderr: SplitParser {
      onRead: function(line) {
        if (String(line).trim() !== "")
          root.serviceError = String(line).slice(0, 512)
      }
    }

    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0)
        root.serviceError = "App Deck service stopped. Reload the shell to retry."
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰀻"
    active: root.phoneConnected
    activeColor: Commons.Color.accent
    tooltipText: root.phoneConnected
      ? "App Deck: phone connected"
      : "Open App Deck pairing details"
    onPressed: root.togglePanel()
  }

  PopupCard {
    id: popup
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.popupOpen
    contentWidth: popup.fittedContentWidth(Style.space(320))
    contentHeight: popup.fittedContentHeight(contentColumn.implicitHeight)

    Column {
      id: contentColumn
      width: parent.width
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: "App Deck"
        color: Commons.Color.popups.text
        font.family: Style.font.family
        font.pixelSize: Style.font.subtitle
        font.bold: true
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        wrapMode: Text.Wrap
        color: Commons.Color.popups.text
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        text: root.serviceError !== ""
          ? root.serviceError
          : root.phoneUrl !== ""
            ? "On your phone, open this address and enter the pairing code:"
            : "Starting the phone connection service…"
      }

      Image {
        visible: root.qrFile !== ""
        cache: false
        anchors.horizontalCenter: parent.horizontalCenter
        source: root.qrFile !== "" ? "file://" + root.qrFile : ""
        sourceSize.width: 220
        sourceSize.height: 220
        width: 220
        height: 220
        fillMode: Image.PreserveAspectFit
        smooth: false
      }

      TextEdit {
        visible: root.phoneUrl !== ""
        readOnly: true
        selectByMouse: true
        textFormat: TextEdit.PlainText
        width: parent.width
        height: contentHeight
        wrapMode: TextEdit.WrapAnywhere
        color: Commons.Color.popups.text
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        text: root.phoneUrl
      }

      TextEdit {
        visible: root.pairingCode !== ""
        readOnly: true
        selectByMouse: true
        textFormat: TextEdit.PlainText
        width: parent.width
        height: contentHeight
        color: Commons.Color.popups.text
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        text: "Pairing code: " + root.pairingCode
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        wrapMode: Text.Wrap
        color: Commons.Color.popups.text
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        text: "Only pair on a trusted private network. The code changes when the shell restarts."
      }
    }
  }
}
