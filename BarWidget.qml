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
  property bool confirmDisconnect: false
  property string setupMessage: ""
  property bool devicesOpen: false
  property var pairedDevices: []
  property string deviceMessage: ""
  property string confirmDevice: ""
  property bool editingDeviceName: false

  readonly property bool opened: popupOpen

  function open() { popupOpen = true }
  function close() {
    popupOpen = false
    confirmDisconnect = false
    confirmDevice = ""
  }
  function togglePanel() {
    if (popupOpen)
      close()
    else
      open()
  }
  function restartService() {
    confirmDisconnect = false
    phoneUrls = []
    qrFiles = []
    pairingCode = ""
    phoneConnected = false
    serviceError = ""
    restartRequested = server.running
    if (server.running)
      server.running = false
    else
      server.running = true
  }
  function runSetup(action, value) {
    if (setup.running)
      return
    setupMessage = "Working…"
    setup.action = action
    var command = ["python3", Qt.resolvedUrl("connection_setup.py").toString().replace(/^file:\/\//, ""), action]
    if (value !== undefined)
      command.push(value)
    setup.command = command
    setup.running = true
  }

  function runDevice(action, deviceId, name) {
    if (deviceManager.running)
      return
    deviceManager.action = action
    var command = ["python3", Qt.resolvedUrl("connection_setup.py").toString().replace(/^file:\/\//, ""), action]
    if (deviceId !== undefined) command.push(deviceId)
    if (name !== undefined) command.push(name)
    deviceManager.command = command
    deviceManager.running = true
  }

  Timer {
    interval: 10000
    running: root.popupOpen && root.devicesOpen && !root.setupOpen && !root.editingDeviceName
    repeat: true
    onTriggered: root.runDevice("devices")
  }

  Process {
    id: deviceManager
    property string action: ""
    property bool succeeded: false
    stdout: SplitParser {
      onRead: function(line) {
        try {
          var info = JSON.parse(String(line))
          deviceManager.succeeded = info.ok === true
          if (info.ok === true && Array.isArray(info.devices)) {
            root.pairedDevices = info.devices
          } else {
            root.deviceMessage = String(info.message || "Could not read paired devices.").slice(0, 512)
          }
        } catch (error) {
          root.deviceMessage = "Could not read paired devices."
        }
      }
    }
    stderr: SplitParser {
      onRead: function(line) {
        if (String(line).trim() !== "")
          root.deviceMessage = "Paired-device management failed."
      }
    }
    onExited: function(exitCode, exitStatus) {
      var refresh = exitCode === 0 && succeeded && action !== "devices"
      if (exitCode !== 0 || !succeeded)
        root.deviceMessage = root.deviceMessage || "Paired-device management failed."
      succeeded = false
      if (refresh) Qt.callLater(function() { root.runDevice("devices") })
    }
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
    property string action: ""
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
        root.restartService()
      } else if (root.setupMessage === "Working…") {
        root.setupMessage = "Connection setup failed."
      }
      if ((exitCode !== 0 || !setup.succeeded) && setup.action === "disconnect")
        root.serviceError = root.setupMessage
      setup.succeeded = false
      setup.action = ""
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
        text: "Only pair on a trusted private network. Paired phones remain connected across shell restarts."
      }

      Button {
        visible: !root.setupOpen
        text: root.devicesOpen ? "Hide paired devices" : "Paired devices"
        foreground: Commons.Color.popups.text
        bordered: true
        onClicked: {
          root.devicesOpen = !root.devicesOpen
          root.confirmDevice = ""
          if (root.devicesOpen) {
            root.deviceMessage = ""
            root.runDevice("devices")
          }
        }
      }

      Column {
        visible: !root.setupOpen && root.devicesOpen
        width: parent.width
        spacing: Style.space(6)

        Text {
          textFormat: Text.PlainText
          width: parent.width
          wrapMode: Text.Wrap
          color: Commons.Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          text: root.deviceMessage || (root.pairedDevices.length === 0 ? "No paired devices. Pair each browser or installed app separately." : "Names are labels, not verified device identities.")
        }

        Flickable {
          width: parent.width
          height: Math.min(deviceList.implicitHeight, Style.space(260))
          contentHeight: deviceList.implicitHeight
          clip: true
          Column {
            id: deviceList
            width: parent.width
            spacing: Style.space(10)
            Repeater {
              model: root.pairedDevices
              Column {
                required property var modelData
                width: deviceList.width
                spacing: Style.space(4)
                TextField {
                  id: deviceLabel
                  width: parent.width
                  text: modelData.name
                  maximumLength: 64
                  onActiveFocusChanged: root.editingDeviceName = activeFocus
                  foreground: Commons.Color.popups.text
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                }
                Text {
                  textFormat: Text.PlainText
                  color: Commons.Color.popups.text
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  text: Date.now() / 1000 - modelData.lastSeen < 45
                    ? "Recently active"
                    : "Last seen: " + new Date(modelData.lastSeen * 1000).toLocaleString()
                }
                Row {
                  spacing: Style.space(6)
                  Button {
                    text: "Save name"
                    foreground: Commons.Color.popups.text
                    bordered: true
                    enabled: !deviceManager.running
                    onClicked: root.runDevice("rename", modelData.id, deviceLabel.text)
                  }
                  Button {
                    text: root.confirmDevice === modelData.id ? "Confirm disconnect" : "Disconnect"
                    foreground: Commons.Color.popups.text
                    bordered: true
                    enabled: !deviceManager.running
                    onClicked: {
                      if (root.confirmDevice === modelData.id) {
                        root.confirmDevice = ""
                        root.runDevice("revoke", modelData.id)
                      } else {
                        root.confirmDevice = modelData.id
                      }
                    }
                  }
                }
                Button {
                  visible: root.confirmDevice === modelData.id
                  text: "Cancel"
                  foreground: Commons.Color.popups.text
                  bordered: true
                  onClicked: root.confirmDevice = ""
                }
              }
            }
          }
        }
      }

      Button {
        visible: !root.setupOpen && !root.confirmDisconnect
        text: "Disconnect all phones"
        foreground: Commons.Color.popups.text
        bordered: true
        enabled: server.running && root.pairingCode !== "" && !setup.running && !root.restartRequested
        onClicked: root.confirmDisconnect = true
      }

      Text {
        visible: !root.setupOpen && root.confirmDisconnect
        textFormat: Text.PlainText
        width: parent.width
        wrapMode: Text.Wrap
        color: Commons.Color.popups.text
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        text: "All phones will need to pair again. Continue?"
      }

      Row {
        visible: !root.setupOpen && root.confirmDisconnect
        spacing: Style.space(6)
        Button {
          text: "Disconnect all"
          foreground: Commons.Color.popups.text
          bordered: true
          enabled: server.running && !setup.running && !root.restartRequested
          onClicked: {
            root.confirmDisconnect = false
            root.runSetup("disconnect")
          }
        }
        Button {
          text: "Cancel"
          foreground: Commons.Color.popups.text
          bordered: true
          onClicked: root.confirmDisconnect = false
        }
      }

      Button {
        text: root.setupOpen ? "Close connection setup" : "Connection setup"
        foreground: Commons.Color.popups.text
        bordered: true
        onClicked: {
          root.confirmDisconnect = false
          root.setupOpen = !root.setupOpen
        }
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
