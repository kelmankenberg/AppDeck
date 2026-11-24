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
  property var phoneUrls: []
  property var qrFiles: []
  property int selectedConnection: 0
  readonly property string phoneUrl: phoneUrls[selectedConnection] || ""
  property string pairingCode: ""
  readonly property string qrFile: qrFiles[selectedConnection] || ""
  property string serviceError: ""
  property bool phoneConnected: false
  property bool setupOpen: false
  property bool restartRequested: false
  property string setupMessage: ""

  readonly property bool opened: popupOpen

  function open() { popupOpen = true }
  function close() { popupOpen = false }
  function togglePanel() { popupOpen = !popupOpen }
  function runSetup(action, value) {
    if (setup.running)
      return
    setupMessage = "Working…"
    var command = ["python3", Qt.resolvedUrl("connection_setup.py").toString().replace(/^file:\/\//, ""), action]
    if (value !== undefined)
      command.push(value)
    setup.command = command
    setup.running = true
  }

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
          root.phoneUrls = Array.isArray(info.urls) ? info.urls : []
          root.qrFiles = Array.isArray(info.qrFiles) ? info.qrFiles : []
          root.selectedConnection = 0
          root.pairingCode = String(info.pairingCode || "")
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
      if (root.restartRequested) {
        root.restartRequested = false
        server.running = true
      } else if (exitCode !== 0 && root.serviceError === "")
        root.serviceError = "App Deck service stopped. Reload the shell to retry."
    }
  }

  Process {
    id: setup
    property bool succeeded: false
    stdout: SplitParser {
      onRead: function(line) {
        try {
          var info = JSON.parse(String(line))
          setup.succeeded = info.ok === true
          root.setupMessage = String(info.message || "").slice(0, 512)
        } catch (error) {
          setup.succeeded = false
          root.setupMessage = "Could not read the setup result."
        }
      }
    }
    stderr: SplitParser {
      onRead: function(line) {
        if (String(line).trim() !== "")
          root.setupMessage = "Connection setup failed. Check the App Deck setup instructions."
      }
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode === 0 && setup.succeeded) {
        root.phoneUrls = []
        root.qrFiles = []
        root.pairingCode = ""
        root.serviceError = ""
        root.restartRequested = server.running
        if (server.running)
          server.running = false
        else
          server.running = true
      } else if (root.setupMessage === "Working…") {
        root.setupMessage = "Connection setup failed."
      }
      setup.succeeded = false
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

      Row {
        visible: !root.setupOpen && root.phoneUrls.length > 1
        spacing: Style.space(4)
        Repeater {
          model: root.phoneUrls.length
          Button {
            text: "Connection " + (index + 1)
            selected: root.selectedConnection === index
            foreground: Commons.Color.popups.text
            onClicked: root.selectedConnection = index
          }
        }
      }

      Text {
        visible: !root.setupOpen
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
        visible: !root.setupOpen && root.qrFile !== ""
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
        visible: !root.setupOpen && root.phoneUrl !== ""
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
        visible: !root.setupOpen && root.pairingCode !== ""
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
        visible: !root.setupOpen
        textFormat: Text.PlainText
        width: parent.width
        wrapMode: Text.Wrap
        color: Commons.Color.popups.text
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        text: "Only pair on a trusted private network. The code changes when the shell restarts."
      }

      Button {
        text: root.setupOpen ? "Close connection setup" : "Connection setup"
        foreground: Commons.Color.popups.text
        bordered: true
        onClicked: root.setupOpen = !root.setupOpen
      }

      Column {
        visible: root.setupOpen
        width: parent.width
        spacing: Style.space(6)

        Text {
          textFormat: Text.PlainText
          width: parent.width
          wrapMode: Text.Wrap
          color: Commons.Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          text: "Tailscale setup adds a private Serve route and may need admin authorization. HTTPS certificates publish the device name. LAN needs an existing trusted HTTPS proxy to 127.0.0.1:8765. Never bypass certificate warnings."
        }

        Button {
          text: "Set up Tailscale"
          foreground: Commons.Color.popups.text
          bordered: true
          enabled: !setup.running
          onClicked: root.runSetup("tailscale")
        }

        Button {
          text: "LAN proxy instructions"
          foreground: Commons.Color.popups.text
          bordered: true
          onClicked: Qt.openUrlExternally("https://github.com/kelmankenberg/AppDeck#install-and-connect")
        }

        TextField {
          id: lanOrigin
          width: parent.width
          placeholderText: "https://your-lan-host:8443"
          foreground: Commons.Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.body
        }

        Row {
          spacing: Style.space(6)
          Button {
            text: "Add LAN address"
            foreground: Commons.Color.popups.text
            bordered: true
            enabled: !setup.running
            onClicked: root.runSetup("add", lanOrigin.text.trim())
          }
          Button {
            text: "Remove selected"
            foreground: Commons.Color.popups.text
            bordered: true
            enabled: !setup.running && root.phoneUrl !== ""
            onClicked: root.runSetup("remove", root.phoneUrl)
          }
        }

        Text {
          visible: root.setupMessage !== ""
          textFormat: Text.PlainText
          width: parent.width
          wrapMode: Text.Wrap
          color: Commons.Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          text: root.setupMessage
        }
      }
    }
  }
}
