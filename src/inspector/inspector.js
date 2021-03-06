// Contains the "Inspector", which allows the user to inspect and investigate
// the X server interactively.

(function(exports) {
    "use strict";

    // A <canvas> that overlays the X server and highlights certain windows
    // by drawing semi-transparent boxes and anchor lines.
    var InspectorHighlighter = new Class({
        initialize: function(server) {
            this._server = server;
            var connection = server.connect();

            this._display = connection.display;
            this._port = connection.clientPort;
            this._port.addEventListener("message", function(messageEvent) {
                this._handleEvent(messageEvent.data);
            }.bind(this));

            this._highlightedWindowId = null;

            this._canvas = document.createElement("canvas");
            this._canvas.classList.add("inspector-highlight");
            this._ctx = this._canvas.getContext('2d');

            server.elem.appendChild(this._canvas);

            this._display.selectInput({ windowId: this._display.rootWindowId,
                                        events: ['SubstructureNotify'] });
            this._syncSize();
        },

        _syncSize: function() {
            var geom = this._display.getGeometry({ drawableId: this._display.rootWindowId });
            this._canvas.width = geom.width;
            this._canvas.height = geom.height;
        },

        _handleEvent: function(event) {
            this._draw();
        },

        _draw: function() {
            this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

            if (this._highlightedWindowId != null) {
                var geom = this._display.getGeometry({ drawableId: this._highlightedWindowId });
                var coords = this._display.translateCoordinates({ srcWindowId: this._highlightedWindowId,
                                                                  destWindowId: this._display.rootWindowId,
                                                                  x: 0, y: 0 });

                this._ctx.fillStyle = 'rgba(100, 140, 200, 0.6)';
                this._ctx.fillRect(coords.x, coords.y, geom.width, geom.height);

                var shape = this._display.getWindowShapeRegion({ windowId: this._highlightedWindowId,
                                                                 shapeType: 'Bounding' });
                if (shape) {
                    this._ctx.save();
                    this._ctx.globalCompositeOperation = 'source-atop';
                    this._ctx.translate(coords.x, coords.y);
                    CanvasUtil.pathFromRegion(this._ctx, shape);
                    this._ctx.fillStyle = 'yellow';
                    this._ctx.fill();
                    this._ctx.restore();
                    this._ctx.beginPath();
                }

                var visibleRegion = this._display.getVisibleRegion({ windowId: this._highlightedWindowId,
                                                                     includeChildren: true });
                this._ctx.save();
                this._ctx.globalCompositeOperation = 'source-atop';
                CanvasUtil.pathFromRegion(this._ctx, visibleRegion);
                this._ctx.fillStyle = 'lightgreen';
                this._ctx.fill();
                this._ctx.restore();
                this._ctx.beginPath();

                var query = this._display.queryTree({ windowId: this._highlightedWindowId });
                if (query.parent) {
                    var parentCoords = this._display.translateCoordinates({ srcWindowId: query.parent,
                                                                            destWindowId: this._display.rootWindowId,
                                                                            x: 0, y: 0 });

                    // Horizontal alignment anchor
                    var anchorY = Math.max(parentCoords.y, coords.y) + 0.5;
                    this._ctx.moveTo(parentCoords.x, anchorY);
                    this._ctx.lineTo(coords.x, anchorY);

                    // Vertical alignment anchor
                    var anchorX = Math.max(parentCoords.x, coords.x) + 0.5;
                    this._ctx.moveTo(anchorX, parentCoords.y);
                    this._ctx.lineTo(anchorX, coords.y);

                    this._ctx.strokeStyle = 'rgba(20, 20, 75, 0.5)';
                    this._ctx.stroke();
                    this._ctx.beginPath();
                }
            }
        },

        setWindowToHighlight: function(xid) {
            if (this._highlightedWindowId)
                this._display.selectInput({ windowId: this._highlightedWindowId,
                                            events: ['!ShapeNotify'] });
            this._highlightedWindowId = xid;
            if (this._highlightedWindowId)
                this._display.selectInput({ windowId: this._highlightedWindowId,
                                            events: ['ShapeNotify'] });

            this._draw();
        },
    });

    // A simple client that takes a pointer grab, allowing the user to click
    // on a window. It also takes a highlighter, which it will use to highlight
    // a specific window on hover.
    var WindowChooser = new Class({
        initialize: function(server, highlighter) {
            this._server = server;
            this._highlighter = highlighter;

            var connection = server.connect();
            this._display = connection.display;
            this._port = connection.clientPort;
            this._port.addEventListener("message", function(messageEvent) {
                this._handleEvent(messageEvent.data);
            }.bind(this));

            this._display.selectInput({ windowId: this._display.rootWindowId,
                                        events: ["X-CursorWindowChanged"] });
            this._cursorWindow = null;
        },

        grab: function() {
            this._display.grabPointer({ windowId: this._display.rootWindowId,
                                        ownerEvents: true,
                                        events: ['ButtonRelease'],
                                        pointerMode: 'Async',
                                        cursor: 'x-cursor' });
        },

        _handleEvent: function(event) {
            switch (event.type) {
            case "ButtonRelease":
                this._display.ungrabPointer();
                this._highlighter.setWindowToHighlight(null);
                this.onChosen(this._cursorWindow);
                this._display.disconnect();
                return;
            case "X-CursorWindowChanged":
                this._cursorWindow = event.newCursorWindow;
                this._highlighter.setWindowToHighlight(event.newCursorWindow);
                return;
            }
        },
    });


    // A simple container to not litter the DOM...
    var tooltipsContainer = document.createElement('tooltips-container');
    document.body.appendChild(tooltipsContainer);

    // A simple custom-content tooltip that tracks the cursor when
    // the user hovers over the target element.
    var Tooltip = new Class({
        initialize: function(target) {
            this._target = target;
            this._target.addEventListener("mouseover", this._onTargetMouseOver.bind(this));
            this._target.addEventListener("mouseout", this._onTargetMouseOut.bind(this));
            this._target.addEventListener("mousemove", this._onTargetMouseMove.bind(this));

            this.elem = document.createElement("div");
            this.elem.classList.add("tooltip");
            this.elem.style.position = "absolute";
            tooltipsContainer.appendChild(this.elem);

            this._setVisible(false);
        },

        destroy: function() {
            // Assume target will be destroyed.

            tooltipsContainer.removeChild(this.elem);
            this.elem = null;
        },

        _setVisible: function(shown) {
            this.elem.style.display = shown ? "block" : "none";
        },

        _updateForEvent: function(e) {
            this.elem.style.left = e.pageX + 'px';
            this.elem.style.top = e.pageY + 'px';
        },

        _onTargetMouseOver: function(e) {
            this._setVisible(true);
            this._updateForEvent(e);
        },

        _onTargetMouseOut: function(e) {
            this._setVisible(false);
        },

        _onTargetMouseMove: function(e) {
            this._updateForEvent(e);
        },
    });

    function empty(node) {
        while (node.firstChild)
            node.removeChild(node.firstChild);
    }

    var WindowTree = new Class({
        initialize: function(server) {
            this._server = server;
            var connection = server.connect();
            this._display = connection.display;
            this._port = connection.clientPort;
            this._port.addEventListener("message", function(messageEvent) {
                this._handleEvent(messageEvent.data);
            }.bind(this));

            this._toplevel = document.createElement('div');
            this._toplevel.classList.add('window-tree');

            this._display.selectInput({ windowId: this._display.rootWindowId,
                                        events: ['X-WindowTreeChanged', 'X-CursorWindowChanged'] });

            this.elem = this._toplevel;
        },

        _handleConfigureNotify: function(event) {
            // The only thing that can change the window tree is a
            // restack. Resizes and moves won't change the window tree,
            // so don't rebuild it in that case.
            if (event.stackMode !== undefined)
                this._syncWindowTree();
        },

        _handleEvent: function(event) {
            switch (event.type) {
                case "X-CursorWindowChanged":
                    return this._setCursorWindow(event.oldCursorWindow, event.newCursorWindow);
                case "ConfigureNotify":
                    return this._handleConfigureNotify(event);
                case "MapNotify":
                case "UnmapNotify":
                case "DestroyNotify":
                    return this._syncWindowTree();
            }
        },

        _getDebugName: function(xid) {
            var debugName;
            if (!debugName)
                debugName = this._display.getProperty({ windowId: xid, name: "DEBUG_NAME" });
            if (!debugName)
                debugName = this._display.getProperty({ windowId: xid, name: "WM_NAME" });
            if (!debugName)
                debugName = "Unnamed Window";

            return debugName;
        },
        _makeWindowLabel: function(xid) {
            var node = document.createElement("div");
            node.classList.add('title');

            var debugNameLabel = document.createElement("span");
            debugNameLabel.classList.add('debug-name');
            debugNameLabel.textContent = this._getDebugName(xid);
            node.appendChild(debugNameLabel);

            var xidLabel = document.createElement("span");
            xidLabel.classList.add('xid');
            xidLabel.textContent = xid;
            node.appendChild(xidLabel);

            var emblems = document.createElement("span");
            node.appendChild(emblems);

            var cursorWindowEmblem = document.createElement("span");
            cursorWindowEmblem.classList.add('cursor-window-emblem');
            emblems.appendChild(cursorWindowEmblem);

            return node;
        },
        _setCursorWindow: function(oldId, newId) {
            if (this._windowTreeNodes[oldId])
                this._windowTreeNodes[oldId].classList.remove("cursor-window");
            if (this._windowTreeNodes[newId])
                this._windowTreeNodes[newId].classList.add("cursor-window");
        },
        selectWindow: function(xid) {
            if (this._windowTreeNodes[this._selectedWindowId])
                this._windowTreeNodes[this._selectedWindowId].classList.remove("selected");
            this._selectedWindowId = xid;
            if (this._windowTreeNodes[this._selectedWindowId])
                this._windowTreeNodes[this._selectedWindowId].classList.add("selected");
        },
        _syncWindowTree: function() {
            var makeNodeForWindow = function(xid) {
                var node = document.createElement("div");
                node.classList.add('window');

                var windowLabel = this._makeWindowLabel(xid);
                node.appendChild(windowLabel);

                var childList = document.createElement("div");
                childList.classList.add('children');
                node.appendChild(childList);

                // Recurse
                var query = this._display.queryTree({ windowId: xid });
                query.children.reverse().forEach(function(childXid) {
                    childList.appendChild(makeNodeForWindow(childXid));
                });

                node.addEventListener("mouseover", function(event) {
                    this.onWindowHighlighted(xid);
                    event.stopPropagation();
                }.bind(this));
                node.addEventListener("mouseout", function(event) {
                    this.onWindowHighlighted(null);
                    event.stopPropagation();
                }.bind(this));
                node.addEventListener("click", function(event) {
                    this.onWindowSelected(xid);
                    event.stopPropagation();
                }.bind(this));

                this._windowTreeNodes[xid] = node;

                return node;
            }.bind(this);

            empty(this._toplevel);
            this._windowTreeNodes = {};

            var rootNode = makeNodeForWindow(this._display.rootWindowId);
            this._toplevel.appendChild(rootNode);

            var pointerInfo = this._display.queryPointer();
            this._setCursorWindow(0, pointerInfo.child);

            // Ensure that the node still appears selected
            this.selectWindow(this._selectedWindowId);
        },
    });

    var HeaderBox = new Class({
        initialize: function(title) {
            this._toplevel = document.createElement('div');

            this._header = document.createElement('div');
            this._header.classList.add('details-header');
            this._header.textContent = title;
            this._toplevel.appendChild(this._header);

            this.content = document.createElement('div');
            this._toplevel.appendChild(this.content);

            this.elem = this._toplevel;
        },

        setVisible: function(visible) {
            this._toplevel.style.display = visible ? 'block' : 'none';
        },
    });


    // Creates a simple that shows a small pixmap, and shows the full
    // pixmap in a Tooltip when hovering over it.
    var PixmapDisplay = new Class({
        initialize: function(server, xid) {
            this._server = server;
            var connection = server.connect();
            this._display = connection.display;

            this._xid = xid;

            this._toplevel = document.createElement('span');

            this._thumbCanvas = document.createElement('canvas');
            this._thumbCanvas.classList.add('pixmap-display-thumb');
            this._toplevel.appendChild(this._thumbCanvas);

            this._tooltip = new Tooltip(this._thumbCanvas);
            this._tooltipCanvas = document.createElement('canvas');
            this._tooltipCanvas.classList.add('pixmap-display');
            this._tooltip.elem.appendChild(this._tooltipCanvas);

            this._tooltipDescription = document.createElement('span');
            this._tooltipDescription.classList.add('tooltip-description');
            this._tooltip.elem.appendChild(this._tooltipDescription);

            this.update();

            this.elem = this._toplevel;
        },

        destroy: function() {
            this._display.disconnect();
            this._display = null;
            empty(this.elem);

            this._tooltip.destroy();
        },

        update: function() {
            var image = this._display.getPixmapImage({ pixmapId: this._xid });

            function updateCanvas(canvas) {
                canvas.width = image.width;
                canvas.height = image.height;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(image, 0, 0);
            }

            this._tooltipDescription.innerHTML = "<span>" + image.width + "</span>×<span>" + image.height + "</span>, XID <span>" + this._xid + "</span>";
            updateCanvas(this._thumbCanvas);
            updateCanvas(this._tooltipCanvas);
        },
    });

    // The right-hand pane of the inspector. It shows the window's geometry,
    // its attributes, and any custom properties.
    var WindowDetails = new Class({
        initialize: function(server) {
            this._server = server;
            var connection = server.connect();
            this._display = connection.display;
            this._port = connection.clientPort;
            this._port.addEventListener("message", function(messageEvent) {
                this._handleEvent(messageEvent.data);
            }.bind(this));

            this._toplevel = document.createElement('div');
            this._toplevel.classList.add('window-details');

            this._geometry = new HeaderBox("Geometry");
            this._geometry.content.classList.add('geometry-box');
            this._toplevel.appendChild(this._geometry.elem);

            this._attributes = new HeaderBox("Attributes");
            this._attributes.content.classList.add('attribute-list');
            this._toplevel.appendChild(this._attributes.elem);

            this._properties = new HeaderBox("Properties");
            this._properties.content.classList.add('property-list');
            this._toplevel.appendChild(this._properties.elem);

            this._noWindowSelected = document.createElement('div');
            this._noWindowSelected.classList.add('no-window-selected');
            this._noWindowSelected.textContent = "No window selected";
            this._toplevel.appendChild(this._noWindowSelected);

            this.elem = this._toplevel;

            this._sync();
        },

        // Creates a simple box/label to show a color.
        _createColorDisplay: function(color) {
            var node = document.createElement('span');

            var colorDisplay = document.createElement('span');
            colorDisplay.classList.add('color-display');
            colorDisplay.style.backgroundColor = color;
            node.appendChild(colorDisplay);

            var valueItem = document.createElement('span');
            valueItem.classList.add('value');
            valueItem.classList.add('literal');
            valueItem.textContent = color;
            node.appendChild(valueItem);

            return node;
        },

        _syncGeometry: function() {
            empty(this._geometry.content);
            var geometry = this._display.getGeometry({ drawableId: this._selectedWindowId });

            var geometrySize = document.createElement('div');
            geometrySize.classList.add('geometry-size');
            geometrySize.innerHTML = '<span>' + geometry.width + '</span>×<span>' + geometry.height + '</span>';
            this._geometry.content.appendChild(geometrySize);

            var geometryPos = document.createElement('div');
            geometryPos.classList.add('geometry-position');
            geometryPos.innerHTML = '<span>' + geometry.x + '</span>, <span>' + geometry.y + '</span>';
            this._geometry.content.appendChild(geometryPos);
        },

        _syncAttributes: function() {
            empty(this._attributes.content);
            var attribs = this._display.getAttributes({ windowId: this._selectedWindowId });

            if (this._pixmapDisplay) {
                this._pixmapDisplay.elem.parentNode.removeChild(this._pixmapDisplay.elem);
                this._pixmapDisplay.destroy();
                this._pixmapDisplay = null;
            }

            if (attribs.backgroundColor) {
                var node = document.createElement('div');
                node.classList.add('attribute');

                var nameNode = document.createElement('span');
                nameNode.classList.add('name');
                nameNode.textContent = 'background-pixel';
                node.appendChild(nameNode);
                node.appendChild(this._createColorDisplay(attribs.backgroundColor));
                this._attributes.content.appendChild(node);
            }

            if (attribs.backgroundPixmap) {
                var node = document.createElement('div');
                node.classList.add('attribute');

                var nameNode = document.createElement('span');
                nameNode.classList.add('name');
                nameNode.textContent = 'background-pixmap';
                node.appendChild(nameNode);

                this._pixmapDisplay = new PixmapDisplay(this._server, attribs.backgroundPixmap);
                node.appendChild(this._pixmapDisplay.elem);

                var xidLabel = document.createElement('span');
                xidLabel.classList.add('value');
                xidLabel.classList.add('xid');
                xidLabel.textContent = attribs.backgroundPixmap;
                this._toplevel.appendChild(xidLabel);

                if (attribs.backgroundColor)
                    node.classList.add('overridden');

                this._attributes.content.appendChild(node);
            }
        },

        _syncProperties: function() {
            empty(this._properties.content);

            var makeNodeForProperty = function(name, value) {
                var node = document.createElement('div');
                node.classList.add('property');

                var nameNode = document.createElement('span');
                nameNode.classList.add('name');
                nameNode.textContent = name;
                node.appendChild(nameNode);

                var valueNode = document.createElement('span');
                valueNode.classList.add('value');
                valueNode.textContent = JSON.stringify(value);
                node.appendChild(valueNode);

                return node;
            };

            var props = this._display.listProperties({ windowId: this._selectedWindowId });
            props.forEach(function(name) {
                var value = this._display.getProperty({ windowId: this._selectedWindowId, name: name });
                var node = makeNodeForProperty(name, value);
                this._properties.content.appendChild(node);
            }.bind(this));
        },

        _sync: function() {
            var hasWindow = !!this._selectedWindowId;
            this._geometry.setVisible(hasWindow);
            this._attributes.setVisible(hasWindow);
            this._properties.setVisible(hasWindow);
            this._noWindowSelected.classList.toggle('visible', !hasWindow);

            if (hasWindow) {
                this._syncGeometry();
                this._syncAttributes();
                this._syncProperties();
            }
        },

        _handleEvent: function(event) {
            switch (event.type) {
                case 'ConfigureNotify':
                    this._syncGeometry();
                break;
                case 'PropertyNotify':
                    this._syncProperties();
                break;
            }
        },

        selectWindow: function(xid) {
            if (this._selectedWindowId == xid)
                return;

            if (this._selectedWindowId)
                this._display.selectInput({ windowId: this._selectedWindowId,
                                            events: ['!ConfigureNotify', '!PropertyNotify'] });
            this._selectedWindowId = xid;
            if (this._selectedWindowId)
                this._display.selectInput({ windowId: this._selectedWindowId,
                                            events: ['ConfigureNotify', 'PropertyNotify'] });
            this._sync();
        },
    });

    var WindowsTab = new Class({
        initialize: function(server) {
            this.tabButton = document.createElement('div');
            this.tabButton.classList.add('inspector-tab-button');
            this.tabButton.textContent = "Windows";

            this._toplevel = document.createElement('div');
            this._toplevel.classList.add('inspector-tab');

            this._paneContainer = document.createElement('div');
            this._paneContainer.classList.add('pane-container');
            this._toplevel.appendChild(this._paneContainer);

            this._windowTree = new WindowTree(server);
            this._paneContainer.appendChild(this._windowTree.elem);

            this._windowDetails = new WindowDetails(server);
            this._paneContainer.appendChild(this._windowDetails.elem);

            this.elem = this._toplevel;

            this._windowTree.onWindowHighlighted = function(xid) {
                this.onWindowHighlighted(xid);
            }.bind(this);
            this._windowTree.onWindowSelected = function(xid) {
                this.selectWindow(xid);
            }.bind(this);
        },

        selectWindow: function(xid) {
            this._windowTree.selectWindow(xid);
            this._windowDetails.selectWindow(xid);
        },
    });

    var PixmapsList = new Class({
        initialize: function(server) {
            this._server = server;
            var connection = server.connect();
            this._display = connection.display;
            var port = connection.clientPort;
            port.addEventListener("message", function(messageEvent) {
                this._handleEvent(messageEvent.data);
            }.bind(this));

            this._display.selectInput({ windowId: this._server.rootWindowId,
                                        events: ['X-PixmapCreated', 'X-PixmapDestroyed', 'X-PixmapUpdated'] });
            this._pixmaps = {};

            this._toplevel = document.createElement('div');
            this._toplevel.classList.add('pixmap-list');

            var pixmaps = this._display.listPixmaps();
            pixmaps.forEach(function(xid) {
                return this._pixmapCreated(xid);
            }.bind(this));

            this.elem = this._toplevel;
        },

        _pixmapCreated: function(xid) {
            if (this._pixmaps[xid]) {
                console.log("already have display for xid", xid);
                return;
            }

            var entry = {};
            this._pixmaps[xid] = entry;

            var elem = document.createElement('div');
            elem.classList.add('pixmap');
            entry.elem = elem;

            var pixmapDisplay = new PixmapDisplay(this._server, xid)
            elem.appendChild(pixmapDisplay.elem);
            entry.display = pixmapDisplay;

            var xidLabel = document.createElement('span');
            xidLabel.classList.add('xid');
            xidLabel.textContent = xid;
            elem.appendChild(xidLabel);

            this._toplevel.appendChild(elem);
        },
        _pixmapDestroyed: function(xid) {
            if (!this._pixmaps[xid]) {
                console.log("don't have any display for xid", xid);
                return;
            }

            this._pixmaps[xid].display.destroy();
            this._toplevel.removeChild(this._pixmaps[xid].elem);
            this._pixmaps[xid] = null;
        },
        _pixmapUpdated: function(xid) {
            if (!this._pixmaps[xid]) {
                console.log("don't have any display for xid", xid);
                return;
            }

            this._pixmaps[xid].display.update();
        },

        _handleEvent: function(event) {
            switch (event.type) {
                case 'X-PixmapCreated':
                    return this._pixmapCreated(event.xid);
                case 'X-PixmapDestroyed':
                    return this._pixmapDestroyed(event.xid);
                case 'X-PixmapUpdated':
                    return this._pixmapUpdated(event.xid);
            }
        }
    });

    var PixmapsTab = new Class({
        initialize: function(server) {
            this.tabButton = document.createElement('div');
            this.tabButton.classList.add('inspector-tab-button');
            this.tabButton.textContent = "Pixmaps";

            this._toplevel = document.createElement('div');
            this._toplevel.classList.add('inspector-tab');

            this._pixmapsList = new PixmapsList(server);
            this._toplevel.appendChild(this._pixmapsList.elem);

            this.elem = this._toplevel;
        }
    });

    var Inspector = new Class({
        initialize: function(server) {
            this._server = server;
            var connection = server.connect();
            this._display = connection.display;

            this._toplevel = document.createElement('div');
            this._toplevel.classList.add('inspector');

            this._toplevel.addEventListener("contextmenu", function(event) {
                event.preventDefault();
            });

            this._header = document.createElement('div');
            this._header.classList.add('header');
            this._toplevel.appendChild(this._header);

            this._windowsTab = new WindowsTab(server);
            this._windowsTab.onWindowHighlighted = function(xid) {
                this._highlighter.setWindowToHighlight(xid);
            }.bind(this);
            this._addTab(this._windowsTab);

            this._pixmapsTab = new PixmapsTab(server);
            this._addTab(this._pixmapsTab);

            this._selectTab(this._windowsTab);

            this._closeButton = document.createElement('div');
            this._closeButton.classList.add('close-button');
            this._closeButton.title = "Close Inspector";
            this._closeButton.addEventListener("click", this.toggle.bind(this));
            this._header.appendChild(this._closeButton);

            this._chooseWindowButton = document.createElement('div');
            this._chooseWindowButton.classList.add('choose-window-button');
            this._chooseWindowButton.title = "Inspect Window";
            this._chooseWindowButton.addEventListener("click", this._chooseWindow.bind(this));
            this._header.appendChild(this._chooseWindowButton);

            this._refreshButton = document.createElement('div');
            this._refreshButton.classList.add('refresh-button');
            this._refreshButton.title = "Redraw X Server";
            this._refreshButton.addEventListener("click", this._redrawServer.bind(this));
            this._header.appendChild(this._refreshButton);

            this._buttons = [];
            this._highlighter = new InspectorHighlighter(server);

            this.elem = this._toplevel;
        },

        addButton: function(button) {
            this._buttons.push(button)
        },

        toggle: function() {
            this.elem.classList.toggle("visible");
            var visible = this.elem.classList.contains("visible");
            this._buttons.forEach(function(button) {
                button.setShowing(visible);
            });
        },

        _addTab: function(tab) {
            this._header.appendChild(tab.tabButton);
            this._toplevel.appendChild(tab.elem);

            tab.tabButton.addEventListener('click', function() {
                this._selectTab(tab);
            }.bind(this));
        },

        _selectTab: function(tab) {
            if (this._currentTab == tab)
                return;

            if (this._currentTab) {
                this._currentTab.tabButton.classList.remove('selected');
                this._currentTab.elem.classList.remove('visible');
            }

            this._currentTab = tab;

            if (this._currentTab) {
                this._currentTab.tabButton.classList.add('selected');
                this._currentTab.elem.classList.add('visible');
            }
        },

        _selectWindow: function(xid) {
            this._selectTab(this._windowsTab);
            this._windowsTab.selectWindow(xid);
        },

        _chooseWindow: function() {
            this._chooseWindowButton.classList.add("active");
            var chooser = new WindowChooser(this._server, this._highlighter);
            chooser.onChosen = function(xid) {
                this._selectWindow(xid);
                this._chooseWindowButton.classList.remove("active");
            }.bind(this);
            chooser.grab();
        },

        _redrawServer: function() {
            this._display.invalidateWindow({ windowId: this._display.rootWindowId,
                                             includeChildren: true });
        },
    });

    exports.Inspector = Inspector;

})(window);
