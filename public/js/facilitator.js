require([
    "jquery", "underscore-template-config", "backbone", "sockjs", "client-models",
    "video", "logger", "auth-localstorage",
    "bootstrap"
], function($, _, Backbone, SockJS, models, video, logging, auth) {


var logger = new logging.Logger("FACILITATOR");

var FacilitatorView = Backbone.View.extend({
    template: _.template($('#facilitator').html()),
    events: {
        'click .hide-app': 'hide',
        'click .add-activity': 'addActivityDialog',
        'click .grow, .shrink': 'toggleSidebar',
    },
    initialize: function(options) {
        _.bindAll(this, "render", "renderActivities", "hide",
                  "addActivityDialog", "toggleSidebar", "handleCrossDocumentMessages");
        this.session = options.session;
        this.event = options.event;
        this.sock = new SockJS(
            document.location.protocol + "//" +
            document.location.hostname + ":" + document.location.port + "/sock"
        );
        if (this.session.get("activities").length == 0) {
            this.session.set("activities", [{type: "about", autoHide: true}]);
        }
        this.session.on("change:activities", this.renderActivities);

        // `auth` tries to read our identity first from values derived from our
        // session cookie (via values set in `_header.ejs`), and second from
        // localStorage (set by previously-read cookie values).  If both of
        // those fail, try getting sockKey from the parent frame's
        // cross-document message.  If all fail, display an error message.
        if (auth.SOCK_KEY) {
            // Yay, we got it from cookies or local storage.
            this.bindSocket();
        } else {
            // Set up a function to listen for a cross-document message with
            // our sockKey in it.
            var tempListener = _.bind(function(evt) {
                if (HANGOUT_ORIGIN_REGEX.test(evt.origin)) {
                    HANGOUT_ORIGIN = evt.origin;
                    if (evt.data.type === "url") {
                        // Unbind ourselves.
                        window.removeEventListener("message", tempListener, false);
                        // Discard the message, except for the sock key -- the
                        // outer frame will rebroadcast it, at which point
                        // we'll handle hangout URL's etc.
                        if (evt.data.args.sockKey) {
                            auth.SOCK_KEY = evt.data.args.sockKey;
                            auth.USER_ID = evt.data.args.userId;
                            this.bindSocket();
                        } else {
                            // No sock-key at all -- error out.
                            logger.error("Ignoring hangout URL; not authenticated");
                            this.session.set("activities", [{type: "no-auth-warning"}]);
                            // Tell the parent frame that we heard it, to
                            // prevent it from raising an alert-box error.
                            postMessageToHangout({type: "url-ack"});
                        }
                    }
                }
            }, this);
            window.addEventListener("message", tempListener, false);
        }
    },
    bindSocket: function() {
        var sock = this.sock;
        var session = this.session;
        // Convenience wrapper for posting messages.
        sock.sendJSON = function(type, data) {
            sock.send(JSON.stringify({type: type, args: data}));
        }
        // onopen, authorize ourselves, then join the room.
        sock.onopen = function() {
            sock.sendJSON("auth", {key: auth.SOCK_KEY, id: auth.USER_ID});
        };

        // onclose, handle disconnections to reload the page.
        sock.onclose = function() {
            app.faces.hideVideoIfActive();
            $('#disconnected-modal').modal('show');
            var checkIfServerUp = function() {
                var ping = document.location;
                $.ajax({
                    url: ping,
                    cache: false,
                    async: false,
                    success: function(msg) {
                        postMessageToHangout({'type': 'reload'});
                    },
                    error: function(msg) {
                        timeout = setTimeout(checkIfServerUp, 250);
                    }
                });
            };
            checkIfServerUp();
        };

        // Our socket is not just correct, not just articulate... it is *on message*.
        sock.onmessage = _.bind(function(message) {
            var msg = JSON.parse(message.data);
            logger.debug("SOCK", msg.type, msg.args);
            switch (msg.type) {
                case "auth-ack":
                    // When we're authorized, join the room for this session.
                    sock.sendJSON("join", {id: "session/" + session.id});
                    break;
                case "join-ack":
					// Once we have a socket open, acknowledge the hangout
					// gadget informing us of the hangout URL.
					window.addEventListener("message",
                                            this.handleCrossDocumentMessages,
                                            false);
                    break;
                case "session/set-hangout-url-err":
                    logger.error("Bad hangout url.");
                    this.faces.hideVideoIfActive();
                    // Get out of here!
                    new SwitchHangoutsDialog({correctUrl: msg.args.url});
                    break;
                case "session/set-activities":
                    this.session.set("activities", msg.args.activities);
                    break;
                case "session/control-video":
                    if (this.currentActivity && this.currentActivity.activity.type == "video") {
                        this.currentActivity.controlVideo(msg.args);
                    }
                    break;
                case "session/event-message":
                    this.displayEventMessage(msg.args);
                    break;
            }
        }, this);
        // Let the server know about changes to the hangout URL.
        session.on("change:hangout-url", function() {
            logger.info("Broadcasting new hangout URL", session.get("hangout-url"));
            sock.sendJSON("session/set-hangout-url", {
                url: session.get("hangout-url"),
                id: session.get("hangout-id"),
                sessionId: session.id
            });
        });
        session.on("change:connectedParticipants", function() {
            sock.sendJSON("session/set-connected-participants", {
                sessionId: session.id,
                connectedParticipants: session.get("connectedParticipants")
            });
        });
        session.on("change:hangout-broadcast-id", function() {
            sock.sendJSON("session/set-hangout-broadcast-id", {
                sessionId: session.id,
                "hangout-broadcast-id": session.get("hangout-broadcast-id")
            });
        });
    },
    handleCrossDocumentMessages:  function(evt) {
		if (HANGOUT_ORIGIN_REGEX.test(evt.origin)) {
			if (evt.data.type == "url") {
                var args = evt.data.args;
				if (args.url) {
					logger.debug("CDM inner set", args.url, args.id, evt.origin);
                    this.session.set("hangout-id", args.id);
					this.session.set("hangout-url", args.url);
                    if (args.youtubeId) {
                        this.session.set("hangout-broadcast-id", args.youtubeId);
                    } else {
                        this.session.set("hangout-broadcast-id", null);
                    }
					HANGOUT_ORIGIN = evt.origin;
					postMessageToHangout({type: "url-ack"});
				}
			} else if (evt.data.type == "participants") {
				logger.debug("CDM inner participants:", evt.data.args);
				var data = evt.data.args.participants;
				if (_.isString(data)) {
					data = JSON.parse(data);
				}
				var participants = _.map(data, function(u) {
					return u.person;
				});
				this.session.setConnectedParticipants(participants);
			}
		}
	},
    renderActivities: function() {
        // We only support 1 activity for now.
        var activityData = this.session.get("activities")[0];
        if (!activityData) { return; }

        if (this.currentActivity) {
            this.currentActivity.remove();
        }
        var view;
        switch (activityData.type) {
            case "video":
                view = new VideoActivity({session: this.session, activity: activityData,
                                          sock: this.sock});
                break;
            case "webpage":
                view = new WebpageActivity({session: this.session, activity: activityData});
                break;
            case "about":
                view = new AboutActivity({session: this.session, event: this.event,
                                          activity: activityData});
                break;
            case "no-auth-warning":
                view = new NoAuthActivity({session: this.session, activity: activityData});
                break;
            default:
                logger.error("Unknown activity", activityData);
                return;
        }
        view.on("activity-settings", this.addActivityDialog)
        // Add it to the el -- we keep it around and hide/show rather than re-render.
        this.$(".activity").html(view.el);
        view.render();
        this.currentActivity = view;
        return view;
    },
    render: function() {
        // This should only be called once -- all subsequent renders are
        // done in `renderActivities`.
        this.$el.html(this.template({session: this.session})).addClass("main-window");
        var activitiesData = this.session.get('activities');
        this.renderActivities();
        this.faces = new FacesView();
        this.$('.left-column').append(this.faces.el);
        this.toggleSidebar();
    },
    hide: function(jqevt) {
        // Hide the unhangout facilitator app.
        if (jqevt) { jqevt.preventDefault(); }
        postMessageToHangout({type: "hide"});
    },
    // Add a youtube video activity, complete with controls for simultaneous
    // playback.
    addActivityDialog: function(jqevt) {
        if (jqevt) { jqevt.preventDefault(); };
        var view = new AddActivityDialog({
            hasCurrentEmbed: this.session.get("activities")[0].type != "about"
        });
        this.faces.hideVideoIfActive();
        view.on("submit", _.bind(function(data) {
            if (!data) {
                data = {type: 'about'}
            }
            this.session.set("activities", [data]);
            this.sock.sendJSON("session/set-activities", {
                sessionId: this.session.id,
                activities: [data]
            });
            this.faces.showVideoIfActive();
        }, this));
        view.on("close", this.faces.showVideoIfActive);
    },
    toggleSidebar: function(jqevt) {
        // This is rather ugly -- it special-cases the heck out of the 'faces'
        // activity in a rather brittle way, moving it to a different div when
        // we go to sidebar mode.  It has lots of edge cases -- which activity
        // is active when 'sidebar' mode is toggled? Etc.
        if (jqevt) { jqevt.preventDefault(); }
        this.$el.toggleClass("sidebar");
        var isSidebar = this.$el.hasClass("sidebar");
        
        // Move the faces app from the default activity list to its own space.
        if (isSidebar) {
            // Shrink to sidebar! 
            this.faces.setActive(true);
            this.faces.resize();
        } else {
            // Expand to main!
            this.faces.setActive(false);
        }
    },
    displayEventMessage: function(args) {
        postMessageToHangout({
            type: "display-notice",
            args: [args.message, true]
        });
    }
});

var BaseActivityView = Backbone.View.extend({
    initialize: function(options) {
        _.bindAll(this, "render");
        if (options.activity) {
            this.activity = options.activity;
        }
        this.session = options.session;
    },
    render: function() {
        var context = {cid: this.cid};
        this.$el.addClass(this.activity.type + "-activity");
        context.activity = this.activity;
        if (this.session) {
            context.session = this.session.toJSON();
        }
        if (this.event) {
            context.event = this.event.toJSON();
        }
        this.$el.html(this.template(context));
        if (this.onrender) {
            this.onrender();
        }
    }
});

var AboutActivity = BaseActivityView.extend({
    template: _.template($("#about-activity").html()),
    activity: {type: "about"},
    events: {
        'click #share-link': function(jqevt) { $(jqevt.currentTarget).select(); },
        'click .cancel-autohide': 'cancelAutohide'
    },
    initialize: function(options) {
        BaseActivityView.prototype.initialize.apply(this, [options]);
        _.bindAll(this, "cancelAutohide");
    },
    onrender: function() {
        if (this.activity.autoHide) {
            var count = 15;
            var that = this;
            that.autoHideInterval = setInterval(function() {
                count--;
                that.$(".countdown").html(count);
                if (count == 0) {
                    clearInterval(that.autoHideInterval);
                    that.$(".hide-app").click();
                }
            }, 1000);
        }
    },
    cancelAutohide: function() {
        if (this.autoHideInterval) {
            clearInterval(this.autoHideInterval);
        }
        $(".auto-hide").hide();
    }
});

var NoAuthActivity = AboutActivity.extend({
    template: _.template($("#no-auth-activity").html())
});

var FacesView = Backbone.View.extend({
    initialize: function() {
        _.bindAll(this, "render", "resize", "setActive",
                        "hideVideoIfActive", "showVideoIfActive");
        $(window).on("resize", this.resize);
    },
    render: function() {
        this.resize();
    },
    resize: function() {
        var pos = this.$el.position();
        var height;
        var dims = {
            top: pos.top,
            left: pos.left,
            width: this.$el.parent().width(),
            height: Math.min(this.$el.parent().height(), $(window).height())
        };
        postMessageToHangout({type: "set-video-dims", args: dims});
    },
    setActive: function(active) {
        this.isActive = active;
        if (active) {
            postMessageToHangout({type: "show-video"});
        } else {
            postMessageToHangout({type: "hide-video"});
        }
    },
    hideVideoIfActive: function() {
        if (this.isActive) { postMessageToHangout({type: "hide-video"}); }
    },
    showVideoIfActive: function() {
        if (this.isActive) { postMessageToHangout({type: "show-video"}); }
    }
});

var VideoActivity = BaseActivityView.extend({
    template: _.template($("#video-activity").html()),
    initialize: function(options) {
        BaseActivityView.prototype.initialize.apply(this, arguments);
        this.sock = options.sock;
        _.bindAll(this, "onrender");
        // Get the title of the video from the data API -- it's not available
        // from the iframe API.
        this.yt = new video.YoutubeVideo({
            ytID: this.activity.video.id,
            showGroupControls: true,
            permitGroupControl: true
        });
        this.yt.on("control-video", _.bind(function(args) {
            args.sessionId = this.session.id;
            args.act
            this.sock.sendJSON("session/control-video", args);
        }, this));
        this.yt.on("video-settings", _.bind(function() {
            this.trigger("activity-settings");
        }, this));
    },
    onrender: function() {
        this.$el.html(this.yt.el);
        this.yt.render();
    },
    controlVideo: function(args) {
        this.yt.receiveControl(args);
    }
});

var WebpageActivity = BaseActivityView.extend({
    template: _.template($("#webpage-activity").html()),
    events: {
        'click .activity-settings': 'triggerActivitySettings'
    },
    initialize: function() {
        BaseActivityView.prototype.initialize.apply(this, arguments);
        _.bindAll(this, 'triggerActivitySettings');
    },
    onrender: function() {
        var iframe = document.createElement("iframe");
        iframe.style.width = iframe.width = "100%";
        iframe.style.height = iframe.height = "100%";
        iframe.style.border = "none";
        iframe.src = this.activity.url;
        iframe.onerror = iframe.onError = function() {
            alert("There was a problem loading that webpage.");
        }

        var loadTimeout = setTimeout(iframe.onerror, 5000);
        var isLoaded = function() {
            clearTimeout(loadTimeout);
            $(".loading").remove();
        }
        // Discussion of this approach to detecting when an iframe has loaded:
        // http://www.nczonline.net/blog/2009/09/15/iframes-onload-and-documentdomain/
        // This doesn't catch 
        if (iframe.attachEvent) {
            iframe.attachEvent("onload", isLoaded);
        } else {
            iframe.onload = isLoaded;
        }
        this.$(".iframe-holder").html(iframe);
    },
    triggerActivitySettings: function() {
        this.trigger("activity-settings");
    }
});

/*
 * Modal dialogs
 */

var BaseModalView = Backbone.View.extend({
    events: {
        'click input[type=submit]': 'validateAndGo'
    },
    initialize: function() {
        _.bindAll(this, "render", "validateAndGo", "validate", "close");
        $("body").append(this.el);
        this.render();
        this.$el.on("hidden", _.bind(function() {
            this.trigger("close");
        }, this));
    },
    render: function() {
        this.$el.html(this.template()).addClass("modal hide fade");
        this.$el.modal('show');
    },
    validateAndGo: function(jqevt) {
        jqevt.preventDefault();
        var data = this.validate();
        if (data) {
            this.trigger("submit", data);
            this.close();
        }
    },
    close: function() {
        this.$el.on("hidden", _.bind(function() {
            this.trigger("close");
            this.remove();
        }, this));
        this.$el.modal("hide");
    }
});

var AddActivityDialog = BaseModalView.extend({
    template: _.template($("#add-activity-dialog").html()),
    events: {
        'click input[type=submit]': 'validateAndGo',
        'click a.remove-embed': 'removeEmbed',
        'change input[type=text]': 'validate'
    },
    initialize: function(options) {
        this.options = options || {};
        BaseModalView.prototype.initialize.apply(this, arguments);
        _.bindAll(this, "removeEmbed");
    },
    render: function() {
        BaseModalView.prototype.render.apply(this, arguments);
        $(".remove-embed").toggle(!!this.options.hasCurrentEmbed);
    },
    removeEmbed: function() {
        this.trigger("submit", null); 
        this.close();
    },
    validate: function() {
        var val, youtubeId, url, re, match;
        val = $.trim(this.$("input[type=text]").val());
        if (!val) {
            return false;
        }
        this.$(".ssl-error-message, .valid-youtube, .valid-webpage").hide();
        if (/^[-A-Za-z0-9_]{11}$/.test(val)) {
            youtubeId = val;
        } else {
            // From http://stackoverflow.com/a/6904504 , covering any of the 15
            // or so different variations on youtube URLs.
            re = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/ ]{11})/i;
            match = re.exec(val);
            if (match) {
                youtubeId = match[1];
            }
        }
        if (youtubeId) {
            this.$(".valid-youtube").show();
            return {type: "video", video: {provider: "youtube", id: youtubeId}};
        } else {
            if (/^https?:\/\/.+$/.test(val)) {
                if (window.location.protocol == "https:" && !/^https.+$/.test(val)) {
                    logger.error("Attempt to add unsecure page to secure hangout");
                    this.$(".ssl-error-message").show();
                    return false;
                }
                url = val;
            } else {
                url = "//" + val;
            }
            return {type: "webpage", url: url};
        }
    },
});

var SwitchHangoutsDialog = BaseModalView.extend({
    template: _.template($("#switch-hangouts").html()),
    initialize: function(options) {
        this.correctUrl = options.correctUrl;
        BaseModalView.prototype.initialize.apply(this, []);
    },
    render: function() {
        this.$el.html(this.template({url: this.correctUrl})).addClass("modal");
        this.$el.modal({backdrop: "static"});
        this.$el.modal('show');
    },
    validate: function(){}
});

/****************************
      Initialization
*****************************/


var HANGOUT_ORIGIN; // Will be set when the hangout CDM's us
var _messageQueue = [];
var postMessageToHangout = function(message) {
    if (message) {
        _messageQueue.push(message);
    }
    if (HANGOUT_ORIGIN) {
        _.each(_messageQueue, function(msg) {
            window.parent.postMessage(msg, HANGOUT_ORIGIN);
        });
        _messageQueue = [];
    } else {
        setTimeout(postMessageToHangout, 10);
    }
};

var app = new FacilitatorView({
    session: new models.Session(SESSION_ATTRS),
    event: new models.Event(EVENT_ATTRS)
});
$("#app").html(app.el);
app.render();

});
