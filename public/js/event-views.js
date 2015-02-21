// The views in this file define all the major pieces of the client-side UI for
// event pages.  We are using Backbone.Marionette for our views, which provides
// some extra layers on top of the basic Backbone view objects.
//
// You can read more about Backbone.Marionette's objects here:
// https://github.com/marionettejs/backbone.marionette/tree/master/docs
//
// Basically, each major model in the system has a corresponding view:
// sessions, users, chat messages, etc. Events are excepted, because the main
// interface is for the entire event. The event app itself is basically the
// event view.
//
// Each view has a matching template (defined in event.ejs) that contains its
// markup. On top of that, it defines various events (to respond to, eg, clicks
// on its own elements) as well as other on-render behavior to change how
// the view looks in response to changes in its model or other application
// state.

define([
   "underscore", "backbone", "video", "logger", "models", "auth", "client-utils",
   "backbone.marionette", "underscore-template-config", "jquery.autosize"
], function(_, Backbone, video, logging, models, auth, utils) {

var views = {};
var logger = new logging.Logger("event-views");

var userViewCache = {};

views.SessionView = Backbone.Marionette.ItemView.extend({
    template: '#session-template',
    className: 'session',
    firstUserView: null,
    ui: {
        attend: '.attend',
        start:'.start',
        deleteButton: '.delete',        // delete is reserved word
        hangoutUsers: '.hangout-users'
    },

    events: {
        'click .attend':'attend',
        'click .start':'start',
        'click .delete':'delete',
        'click h3':'headerClick'
    },

    initialize: function() {
        // if we get a notice that someone has connected to the associated participant,
        // re-render to show them.
        this.listenTo(this.model, 'change:connectedParticipants', this.render, this);
        this.listenTo(this.model, 'change:joiningParticipants', this.render, this);
        // Maintain a list of slots and user preferences for them, so that we
        // can render people in consistent-ish places in the list.
        // The idea is that each user gets a "slotPreference", which is either
        // the last slot they were rendered in.  If their preferred slot is occupied,
        // they get the next unused slot, and their "preference" is updated.
        this.userSlotPreference = {};
        this.userSlots = {};
    },

    onRender: function() {
        var start = new Date().getTime();
        this.$el.attr("data-session-id", this.model.id);
        // mostly just show/hide pieces of the view depending on
        // model state.
        this.$el.addClass("live");

        // remove the toggle-ness of the button once the event starts.
        this.ui.attend.attr("data-toggle", "");
        this.ui.attend.removeClass("btn-info");
        this.ui.attend.removeClass("active");
        this.ui.attend.addClass("btn-success");

        var numAttendees = this.model.getNumConnectedParticipants() + this.model.get("joiningParticipants").length;

        // 
        // Build the list of user views.
        //

        var fragment = document.createDocumentFragment();

        // clear out slots for users that are no longer connected, and
        // construct an array of any slots that are available.
        var connectedAndJoining = _.pluck(this.model.get("connectedParticipants"), "id")
            .concat(_.pluck(this.model.get("joiningParticipants"), "id"));
        var available = [];
        var joinCap = this.model.get("joinCap") || this.model.MAX_ATTENDEES;
        for (var i = 0; i < this.model.MAX_ATTENDEES; i++) {
            // Delete the slot if the user isn't here anymore, or if the
            // slot is greater than the joinCap.
            if (this.userSlots[i]) {
                if (!_.contains(connectedAndJoining, this.userSlots[i].id) ||
                      i >= this.model.get("joinCap")) {
                    delete this.userSlots[i];
                }
            } else if (i < joinCap) {
                available.push(i);
            }
        }

        var drawUser = _.bind(function (udata, joining) {
            // Get the user view.
            var userView;
            if (udata.id in userViewCache) {
                userView = userViewCache[udata.id];
            } else {
                // vivify the user into a model when passing it in.  Note that
                // any events bound on the `users` collection of connected
                // participants won't work here.  When users join a session
                // without being connected to the `events` page, they won't appear
                // in that collection anyway.
                userView = new views.UserView({model:new models.User(udata)});
                userViewCache[udata.id] = userView;
            }
            var el = userView.render().el.cloneNode(true);
            if (joining) {
                el.className += " joining";
            }

            // Determine where it goes.
            var slot = this.userSlots[this.userSlotPreference[udata.id]];
            if (slot && slot.id === udata.id) {
                slot.el = el;
            } else {
                var pos = null;
                var pref = this.userSlotPreference[udata.id];
                if (pref && _.contains(available, pref)) {
                    pos = pref;
                    available = _.without(available, pref);
                } else if (available.length > 0) {
                    pos = available.shift();
                }
                if (pos !== null) {
                    this.userSlotPreference[udata.id] = pos;
                    slot = {id: udata.id, el: el}
                    this.userSlots[pos] = slot;
                }
            }
        }, this);

        // build slots for connected users
        _.each(this.model.get("connectedParticipants"), function(udata) { drawUser(udata); });
        // ... and joining users
        _.each(this.model.get("joiningParticipants"), function(udata) { drawUser(udata, true); });
        var emptyli;
        for (var i = 0; i < joinCap; i++) {
            if (this.userSlots[i]) {
                fragment.appendChild(this.userSlots[i].el);
            } else {
                emptyli = document.createElement("li");
                emptyli.className = "empty";
                fragment.appendChild(emptyli);
            }
        }

        // Now add the fragment to the layout and display it
        this.ui.hangoutUsers.html(fragment);
        this.ui.hangoutUsers.show();

        if (!this.options.event.get("sessionsOpen") || numAttendees >= this.model.get("joinCap")) {
            this.ui.attend.find(".lock").show();
            this.ui.attend.attr("disabled", true);
            this.ui.attend.addClass("disabled");

            if (numAttendees >= joinCap) {
                this.ui.attend.find(".text").text("FULL");
            } else {
                this.ui.attend.find(".text").text("LOCKED");
            }
        } else {
            this.ui.attend.find(".lock").hide();
            this.ui.attend.find(".text").text("JOIN");
            this.ui.attend.removeAttr("disabled");
            this.ui.attend.removeClass("disabled");
        }
    },

    destroy: function() {
        this.model.destroy();
    },

    attend: function() {
        // if the event currently has closed sessions, ignore
        // clicks on the join button.
        if(!this.options.event.get("sessionsOpen")) {
            return;
        }

        // if the event has started, button presses should attempt to join
        // the hangout.
        var url = "/session/" + this.model.get("session-key") +
                  "?nocache=" + new Date().getTime();
        window.open(url);
    },

    "delete": function() {
        this.options.transport.send("delete-session", {
            id: this.model.id, roomId: this.options.event.getRoomId()
        });
    }
});

// The list view contains all the individual session views. We don't
// manually make the session views - all that is handled by the
// marionette CollectionView logic.
views.SessionListView = Backbone.Marionette.CollectionView.extend({
    template: "#session-list-template",
    itemView: views.SessionView,
    itemViewContainer: '#session-list-container',
    emptyView: Backbone.Marionette.ItemView.extend({
        template: "#session-list-empty-template"
    }),
    id: "session-list",

    itemViewOptions: function() {
        return {event: this.options.event, transport: this.options.transport};
    }
});


// UserViews are the little square profile pictures that we use throughout
// the app to represent users.

views.UserView = Backbone.Marionette.ItemView.extend({
    template: '#user-template',
    className: 'user focus',
    tagName: "li",

    events: {
        'click' : 'click'
    },


    click: function() {
        logger.log("user clicked: " + this.model.get("displayName"));
    },

    onRender: function() {
        // add in the tooltip attributes
        if(this.model.isAdminOf(this.options.event)) {
             this.$el.addClass("admin");
        }

        // look for either an img or an i child, since people who don't have
        // a g+ icon should still get tooltips
        this.$el.find("img, i").attr("data-toggle", "tooltip");

        // if we're a child of hangout-users, then we're a small session user icon,
        // not a big presence gutter icon. in this case, make the data container
        // the session.
        if(this.$el.parent().hasClass("hangout-users")) {
            // this.$el.find("img, i").attr("data-container", "#chat-container-region");
            this.$el.find("img, i").attr("data-placement", "top");
        } else {
            this.$el.find("img, i").attr("data-container", "body");
            this.$el.find("img, i").attr("data-placement", "left");
        }

        this.$el.find("img, i").attr("title", this.model.get("displayName"));
        this.$el.find("img, i").tooltip({'placement':'top'});
    }
});

// Turn a string into a session message.
function formatSessionMessage(val) {
    return "##unhangouts## " + auth.USER_NAME + ": " + $.trim(val);
}

// The DialogView contains all our dialog boxes. This is a little awkward, but
// when we tried associated dialog boxes with the views that actually trigger them
// we ran into all sorts of z-index issues, because those views were all
// over the DOM and had different situations. Instead, we just put them
// all in one place for easy bootstrap dialog triggering. We also house
// the relevant events related to those dialog boxes here.
views.DialogView = Backbone.Marionette.Layout.extend({
    template: "#dialogs-template",

    id: "dialogs",

    events: {
        'click #send-session-message': 'sendSessionMessage',
        'click #disconnected-modal a':'closeDisconnected',
        'click #create-session':'createSession',
        'change [name=session_type]': 'changeSessionType',
        'click .add-url-to-message': 'addUrlToSessionMessage',
        'change #session_message': 'updateSessionMessage',
        'keydown #session_message': 'updateSessionMessage',
        'keyup #session_message': 'updateSessionMessage'
    },
    addUrlToSessionMessage: function(event) {
        event.preventDefault();
        var el = $("#message-sessions-modal textarea");
        var val = el.val();
        el.val(val + "\n Copy and paste: " + window.location.href.split("#")[0]);
        el.change();
    },
    updateSessionMessage: function(event) {
        $("#message-sessions-modal .faux-hangout-notice .message").html(
            _.escape(formatSessionMessage($("#session_message").val()))
        );
    },
    sendSessionMessage: function(event) {
        event.preventDefault();
        var val = $("#session_message").val();
        if (!val) { return; }
        var args = {
            message: formatSessionMessage(val),
            roomId: this.options.event.getRoomId()
        };
        this.options.transport.send("broadcast-message-to-sessions", args);
        $("#message-sessions-modal").modal('hide');
    },
    changeSessionType: function() {
        var val = this.$("[name='session_type']:checked").val();

        switch (val) {
            case "simple":
                this.$(".youtube-url, .webpage-url").hide();
                break;
            case "video":
                this.$(".youtube-url").show();
                this.$(".webpage-url").hide();
                break;
            case "webpage":
                this.$(".webpage-url").show();
                this.$(".youtube-url").hide();
                break;
        }
    },
    createSession: function(event) {
        event.preventDefault();
        var scope = $("#create-session-modal");
        var title = $("[name=session_name]", scope).val();
        var joinCap = parseInt($.trim($("[name=join_cap]", scope).val()));
        var type = $("[name='session_type']:checked", scope).val();
        var MAX_TITLE = 100;

        if (isNaN(joinCap) || joinCap < 2 || joinCap > 10) {
            $(".join-cap-error", scope).show();
            return;
        }

        if(title.length > MAX_TITLE) {
            $(".title-length-error", scope).show();
            return;
        }

        var activities = [];
        switch (type) {
            case "simple":
                activities.push({type: "about", autoHide: true});
                break;
            case "video":
                var ytid = video.extractYoutubeId($("#session_youtube_id", scope).val());
                if (!ytid) {
                    $(".yt-error", scope).show();
                    $("#session_youtube_id", scope).parent().addClass("error");
                    return;
                } else {
                    activities.push({type: "video", video: {provider: "youtube", id: ytid}});
                }
                break;
            case "webpage":
                var url = this.$("#session_webpage").val();
                if (!/^https:\/\//.test(url)) {
                    $(".url-error", scope).show();
                    $("#session_webpage", scope).parent().addClass("error");
                    return;
                } else {
                    activities.push({type: "webpage", url: url});
                }
                break;
        }

        this.options.transport.send("create-session", {
            title: title,
            description:"",
            activities: activities,
            joinCap: joinCap,
            roomId: this.options.event.getRoomId()
        });
        $("input[type=text]", scope).val("");
        $(".yt-error, .url-error, .join-cap-error", scope).hide();
        $(".error", scope).removeClass(".error");
        scope.modal('hide');
    },

    closeDisconnected: function() {
        $("#disconnected-modal").modal('hide');
    }
});

// Generates the admin menu items.
views.AdminButtonView = Backbone.Marionette.Layout.extend({
    template: "#admin-button-template",

    id: "admin-button",

    firstRun: true,

    events: {
        'click #open-sessions':'openSessions',
        'click #close-sessions':'closeSessions',
        'click #message-sessions': 'messageSessions',
        'click #admin-stop-event': 'stopEvent',
        'click #admin-start-event': 'startEvent'
    },

    openSessions: function(jqevt) {
        jqevt.preventDefault();
        this.options.transport.send("open-sessions", {
            roomId: this.options.event.getRoomId()
        });
    },

    closeSessions: function(jqevt) {
        jqevt.preventDefault();
        this.options.transport.send("close-sessions", {
            roomId: this.options.event.getRoomId()
        });
    },

    startEvent: function(jqevt) {
        jqevt.preventDefault();
        this._startStopEvent("start");
    },
    stopEvent: function(jqevt) {
        jqevt.preventDefault();
        this._startStopEvent("stop");
    },
    _startStopEvent: function(action) {
        $.ajax({
            type: 'POST',
            url: "/admin/event/" + this.options.event.id + "/" + action
        }).fail(function(err) {
            logger.error(err);
            alert("Server error!");
        });
    },

    messageSessions: function(jqevt) {
        jqevt.preventDefault();
        $("#message-sessions-modal").modal('show');

    },

    serializeData: function() {
        return {
            event: this.options.event,
        };
    }
});

// The UserColumn is the gutter on the right that shows who's connected to the
// unhangout right now. We use a layout to encapsulate it and provide the UI
// around the core set of UserViews. You can read more about layouts in the
// Backbone.Marionette docs.
views.UserColumnLayout = Backbone.Marionette.Layout.extend({
    template: "#user-column-layout-template",

    id: "user-column",

    userListView: null,

    regions: {
        userList: "#user-list",
        footer: "#footer"
    },

    initialize: function() {
        this.userListView = new views.UserListView({collection:this.options.users});
    },

    onRender: function() {
        this.userList.show(this.userListView);
    },
});

// The actual core UserListView that manages displaying each individual user.
views.UserListView = Backbone.Marionette.CompositeView.extend({
    template: '#user-list-template',
    itemView: views.UserView,
    itemViewContainer: "#user-list-container",
    id: "user-list",

    initialize: function() {
        this.listenTo(this.collection, 'add remove', function() {
            // going to manually update the current user counter because
            // doing it during render doesn't seem to work. There's some
            // voodoo in how marionette decides how much of the view to
            // re-render on events, and it seems to exclude the piece out-
            // side the item-view-container, assuming it doesn't have
            // reactive bits.
            // I would also expect this to be .totalRecords, but for
            // some reason totalRecords doesn't decrease when records
            // are removed, but totalUnfilteredRecords does. Could
            // be a bug.

            this.$el.find(".header .contents").text(this.collection.length);
        }, this);
    },

    serializeData: function() {
        var data = {};

        data = this.collection.toJSON();

        data.numUsers = this.collection.length;

        logger.log("running user list serialize data");
        return data;
    },

    update: function() {
        logger.log("rendering UserListView");
        this.render();
    }
});

// Manages chat message display. The layout piece sets up the differnt chat zones:
// the area where we show messages, the space where we put users, and the space
// where chat messages are entered.
views.ChatLayout = Backbone.Marionette.Layout.extend({
    template: '#chat-layout',
    id: 'chat',

    regions: {
        whiteboard: '#chat-whiteboard',
        chat:'#chat-messages',
        presence: '#presence-gutter',
        chatInput: '#chat-input-region'
    },

    initialize: function(options) {
        Backbone.Marionette.View.prototype.initialize.call(this, options);
        this.whiteboardView = new views.WhiteboardView({
            model: this.options.event,
            transport: this.options.transport,
            messages: this.options.messages
        });
        this.chatView = new views.ChatView({
            collection: this.options.messages,
            users: this.options.users,
            event: this.options.event
        });
        this.userListView = new views.UserListView({
            collection: this.options.users,
            event: this.options.event
        });
        this.chatInputView = new views.ChatInputView({
            event: this.options.event,
            transport: this.options.transport
        });
    },

    onRender: function() {
        this.whiteboard.show(this.whiteboardView);
        this.chat.show(this.chatView);
        this.presence.show(this.userListView);
        this.chatInput.show(this.chatInputView);
    }
});

// Whiteboard for displaying persistent lobby messages
views.WhiteboardView = Backbone.Marionette.ItemView.extend({
    template: '#chat-whiteboard-template',

    events: {
        'click .edit-whiteboard': 'toggleForm',
        'click .cancel-whiteboard': 'toggleForm',
        'click .update-whiteboard': 'sendForm'
    },

    ui: {
        form: '#whiteboard-form',
        formInput: '#whiteboard-form textarea',
        buttons: '#whiteboard-buttons',
        message: '#whiteboard-message'
    },

    initialize: function(options){
        Backbone.Marionette.ItemView.prototype.initialize.call(this,options);

        this.listenTo(this.model, 'change:whiteboard', this.render, this);
    },

    // Function to send the data from the form
    sendForm: function() {
        var message = this.ui.formInput.val();

        // If the message is the same as the one from what is in the database
        if(message == this.model.attributes.whiteboard.message){
            this.toggleForm();
        } else {
            // Sending the whiteboard message
            this.options.transport.send("edit-whiteboard", {
                newMessage: message,
                roomId: this.options.model.getRoomId()
            });
        }
    },

    // Function to toggle the view of the form only if the user is an admin
    toggleForm: function(){
        if(IS_ADMIN){
            this.ui.form.toggle();
            this.ui.buttons.toggle();
            this.ui.message.toggle();

            if(this.ui.form.is(':visible')){
                this.ui.formInput.val(this.model.attributes.whiteboard.message);
                this.ui.formInput.focus();

                // We autosize the form input so that it follows the user
                $(this.ui.formInput).autosize();
            }
        }
    },

    onRender: function(){
        var message = this.ui.message.html();
        var whiteboard = this.model.attributes.whiteboard;

        if(whiteboard && whiteboard.message && whiteboard.message.length > 0){
            // If there is a whiteboard message we will linkify it.
            this.ui.message.html(utils.linkify(_.escape(whiteboard.message)));
        } else {
            // If not an admin, we hide the whole whiteboard, else we show an empty whiteboard for admins
            if(IS_ADMIN){
                this.ui.message.html('')
            } else {
                this.ui.message.hide();
            }

        }
    },

    serializeData: function() {
        var chatArchiveUrl = null;
        if (this.options.messages.length > 0) {
            chatArchiveUrl = this.model.getChatArchiveUrl();
        }
        return _.extend(this.model.toJSON(), {
            chatArchiveUrl: this.model.getChatArchiveUrl()
        });
    }
});

// The input form for sending chat messages.
views.ChatInputView = Backbone.Marionette.ItemView.extend({
    template: '#chat-input-template',

    events: {
        'submit form':'chat'
    },

    ui: {
        chatInput: "#chat-input",
        asAdmin: "[name='chat-as-admin']"
    },

    initialize: function(options) {
        Backbone.Marionette.View.prototype.initialize.call(this, options);
    },

    chat: function(e) {
        var msg = this.ui.chatInput.val();
        var postAsAdmin = IS_ADMIN && this.ui.asAdmin.is(":checked");

        if(msg.length>0) {
            this.options.transport.send("chat", {
                text: msg,
                postAsAdmin: postAsAdmin,
                roomId: this.options.event.getRoomId()
            });
            this.ui.chatInput.val("");
        }

        e.preventDefault();
        return false;
    },

    onRender: function() {
        if(!this.options.event.get("open")) {
            this.$el.find("#chat-input").attr("disabled", true);
            this.$el.find("#chat-input").addClass("disabled");
        } else {
            this.$el.find("#chat-input").removeAttr("disabled");
            this.$el.find("#chat-input").removeClass("disabled");
        }
        this.$("[data-role='tooltip']").tooltip();
    }
});

// The view for an individual chat message.
views.ChatMessageView = Backbone.Marionette.ItemView.extend({
    template: '#chat-message-template',
    atnameTemplate: _.template($("#chat-atname-template").html()),
    className: 'chat-message',
    tagName: 'li',

    initialize: function() {
        Backbone.Marionette.ItemView.prototype.initialize.apply(this, arguments);
        var msg = _.escape(this.model.get("text"));
        msg = utils.linkify(msg);
        msg = this.atify(msg);
        this.model.set("text", msg);
    },
    atify: function(msg) {
      function matchAll(regex, string) {
        if (!regex.global) {
          throw new Error("RegEx must have global flag to use matchAll");
        }
        var match = null;
        var matches = [];
        while (match = regex.exec(string)) {
          matches.push(match);
        }
        return matches;
      };
      function normalize(name) {
        return name.replace(/\s/g, "").toLowerCase();
      };
      function quoteRegExp(pattern) {
        return pattern.replace(/([.?*+^$[\]\\(){}|-])/g, "\\$1");
      };
      function replaceAtName(msg, atname, replacement) {
        return msg.replace(new RegExp("(" + quoteRegExp(atname) + ")", "gi"),
                           replacement);
      };

      var matches = matchAll(/@([a-zA-Z0-9]+)/g, msg);
      var selfName = normalize(auth.USER_NAME);
      var users = this.options.users;
      _.each(matches, _.bind(function(match) {
        // Is it referring to ourselves?
        var atname = normalize(match[1]);
        if (selfName.indexOf(atname) !== -1) {
          msg = replaceAtName(msg, "@" + atname, $.trim(this.atnameTemplate({
            isMe: true,
            displayName: auth.USER_NAME
          })));
          var text = "✉ Message! ";
          var interval = setInterval(function() {
            if (document.title.indexOf(text) === 0) {
              document.title = document.title.replace(text, "");
            } else {
              document.title = text + document.title;
            }
          }, 500);
          setTimeout(function() {
            document.title = document.title.replace(text, "");
            clearTimeout(interval);
          }, 5000);
        } else {
          var user = users.find(function(user) {
            return normalize(user.get("displayName")).indexOf(atname) !== -1;
          });
          if (user) {
            msg = replaceAtName(msg, "@" + atname, $.trim(this.atnameTemplate({
              isMe: false,
              user: user
            })));
          }
        }
      }, this));
      return msg;
    },

    // We want to use shortNames so we intercept this process to make the short
    // display name visible within the template rendering, since we can't
    // call object methods during that process.
    serializeData: function() {
        var model = this.model.toJSON();

        // if we have a user object (ie if we're not a system generated
        // message) then convert its name to the short display name.
        if(this.model.has("user")) {
            var tempUser = new models.User(this.model.get("user"));
            model.user.shortDisplayName = tempUser.getShortDisplayName();
        } else {
            // fill in a sort of fake empty name, just to the templating
            // system doesn't freak out.
            model.user = {shortDisplayName:""};
        }
        return model;
    },

    onRender: function() {

        if (!this.model.has("user")) {
            // mark this chat message as a system message, so we can
            // display it differently.
            this.$el.addClass("system");
        } else if (this.options.isAdmin && this.model.get("postAsAdmin")) {
            this.$el.find(".chat-message-author").addClass("admin");
        }

        if (this.model.get("past")) {
            this.$el.addClass("past");
        }
        this.$el.find("[data-toggle='popover']").popover({html: true});
        console.log
    }
});

// This view contains all the ChatMessageViews and handles scrolling for them.

views.ChatView = Backbone.Marionette.CompositeView.extend({
    template: '#chat-template',
    itemView: views.ChatMessageView,
    itemViewContainer: "#chat-list-container",
    id: "chat-container",

    initialize: function() {
        Backbone.Marionette.CompositeView.prototype.initialize.apply(this, arguments);
        this.collection.on("over-capacity", _.bind(function() {
            if (this._overCapacityTimeout) {
                clearTimeout(this._overCapacityTimeout);
            }
            this.$(".over-capacity-warning").show();
            this._overCapacityTimeout = setTimeout(_.bind(function() {
                this.$(".over-capacity-warning").fadeOut();
            }, this), 3000);

        }, this));
    },
    itemViewOptions: function(model, index) {
        return {
            model: model,
            isAdmin: new models.User(model.get("user")).isAdminOf(this.options.event),
            users: this.options.users
        };
    },
    onBeforeItemAdded: function() {
        this.scroller = $("#chat-container-region .panel-body");
        if (this.scroller.length > 0) {
            var limit = Math.max(this.scroller[0].scrollHeight - this.scroller.height() - 10, 0);
            this._isScrolled = this.scroller.scrollTop() < limit;
            return null;
        }
    },
    onAfterItemAdded: function() {
        var latest = this.collection.at(this.collection.length - 1);
        // Scroll down if we haven't moved our scroll bar, or the last message
        // was from ourselves.
        if (!this._isScrolled || latest.get("user").id == auth.USER_ID) {
            this.scroller.scrollTop(this.el.scrollHeight);
        }
    }
});

// The bar that appears when your session goes live.
views.SessionLiveView = Backbone.Marionette.ItemView.extend({
    template: "#session-live-bar-template",
    id: "session-live-bar"
});

views.AboutEventView = Backbone.Marionette.ItemView.extend({
    template: "#about-event-template",
    id: "about-event",

    initialize: function() {
        this.listenTo(this.model, 'change:description', _.bind(function() {
            $(".updated").removeClass("hide");
            this.render();
        }, this), this);
    },
    serializeData: function() {
        var context = this.model.toJSON();
        context.event = this.model;
        return context;
    },

    onRender: function() {
        if(this.model.get("open")) {
            this.$el.find(".footer").hide();
        } else {
            this.$el.find(".footer").show();
        }
    }
});

// Manages the display of embedded videos on the upper left corner.
views.VideoEmbedView = Backbone.Marionette.ItemView.extend({
    id: 'video-embed',
    template: '#video-embed-template',
    controlsTemplate: _.template($("#video-embed-controls-template").html()),
    previousVideoDetailsTemplate: _.template($("#previous-video-details-template").html()),
    ui: {
        player: ".video-player",
        placeholder: ".video-placeholder",
        controls: ".video-controls",
    },
    events: {
        'click .set-video': 'setVideo',
        'click .enqueue-video': 'enqueueVideo',
        'click .remove-video': 'removeVideo',
        'click .restore-previous-video': 'restorePreviousVideo',
        'click .clear-previous-videos': 'clearPreviousVideos',
        'click .play-for-all': 'playForAll',
        'click .remove-hoa': 'removeHoA',
        'click .remove-one-previous-video': 'removeOnePreviousVideo'
    },

    player: null,

    initialize: function() {
        this.listenTo(this.model, "change:youtubeEmbed", function(model, youtubeEmbed) {
            if (youtubeEmbed) {
                this.setPlayerVisibility(true);
                this.yt.setVideoId(this.model.get("youtubeEmbed"));
            } else {
                this.setPlayerVisibility(false);
            }
            this.renderControls();
        }, this);
        this.listenTo(this.model, "hoa:change:connectedParticipants " +
                                  "hoa:change:joiningParticipants " + 
                                  "hoa:change:hangout-url " +
                                  "hoa:change:hangout-pending " +
                                  "change:hoa",
                        this.renderControls);
        // This might get double-renders for changed youtube embeds... but
        // that's not a big deal, it doesn't happen at high velocity.
        this.listenTo(this.model, "change:previousVideoEmbeds", this.renderControls);
    },
    serializeData: function() {
        var context = this.model.toJSON();
        context.hoa = null;
        if (this.model.get("hoa")) {
            context.hoa = this.model.get("hoa").toJSON();
        }
        return context;
    },
    setVideo: function(jqevt) {
        this._addVideo(jqevt, "embed");
    },
    enqueueVideo: function(jqevt) {
        this._addVideo(jqevt, "enqueue");
    },
    _addVideo: function(jqevt, action) {
        jqevt.preventDefault();
        var youtubeInput = this.$("input[name='youtube_id']");
        var youtubeInputParent = youtubeInput.parent();
        var youtubeInputError = this.$(".text-warning");
        var ytId = video.extractYoutubeId(youtubeInput.val());
        if (ytId === null || ytId === undefined) {
            // Invalid youtube URL/embed code specified.
            youtubeInputError.show();
            youtubeInputParent.addClass("error");
        } else {
            youtubeInputParent.removeClass("error");
            youtubeInputError.hide();
            this.options.transport.send(action, {
                ytId: ytId, roomId: this.model.getRoomId()
            });
        }

    },
    removeVideo: function(jqevt) {
        jqevt.preventDefault();
        this.model.set("youtubeEmbed", null);
        this.options.transport.send("embed", {
            ytId: null, roomId: this.model.getRoomId()
        });
    },
    removeHoA: function(jqevt) {
        jqevt.preventDefault();
        // ensure hangout-broadcast-id is null, even if other things are
        // incongruent.
        this.model.set("hoa", null);
        this.options.transport.send("remove-hoa", {
            roomId: this.model.getRoomId()
        });
    },
    playForAll: function(jqevt) {
        this.yt.playForEveryone(jqevt);
    },
    restorePreviousVideo: function(jqevt) {
        jqevt.preventDefault();
        var ytId = $(jqevt.currentTarget).attr("data-youtube-id");
        this.options.transport.send("embed", {
            ytId: ytId,
            roomId: this.model.getRoomId()
        });
    },
    clearPreviousVideos: function(jqevt) {
        jqevt.preventDefault();
        if (confirm("Clear list of videos? There's no undo.")) {
            this.options.transport.send("clear-previous-videos", {
                roomId: this.model.getRoomId()
            });
        }
    },
    removeOnePreviousVideo: function(jqevt) {
        var ytId = $(jqevt.currentTarget).attr("data-youtube-id");
        this.options.transport.send("remove-one-previous-video", {
            ytId: ytId,
            roomId: this.model.getRoomId()
        });
    },
    setPlayerVisibility: function(visible) {
        // Display player if it's visible.
        this.ui.player.toggle(visible);
        // Show a placeholder ("video goes here") if video is not visible and
        // the user is an admin.  Non-admins get nothing.
        this.ui.placeholder.toggle(!visible && IS_ADMIN);
        // Always show controls if the user is an admin.
        this.ui.controls.toggle(IS_ADMIN);
    },
    renderControls: function() {
        var hoa = this.model.get("hoa");
        var context = _.extend(this.model.toJSON(), {
            numHoaParticipants: hoa ? hoa.getNumConnectedParticipants() : null,
            isPlayingForEveryone: this.yt.isPlayingForEveryone(),
            isAwaitingStart: this.yt.isAwaitingStart()
        });
        if (hoa && (hoa.get("hangout-url") || hoa.get("hangout-pending"))) {
            context.hoaParticipationLink = hoa.getParticipationLink();
        } else {
            context.hoaParticipationLink = null;
        }

        this.ui.controls.html(this.controlsTemplate(context));

        // We reset the dropdowns because the the previous video embeds dropdown is recreated.
        $('.dropdown-toggle').dropdown();

        // Make the video details pretty.
        _.each(this.model.get("previousVideoEmbeds"), _.bind(function(embed) {
            video.getVideoDetails(embed.youtubeId, _.bind(function(data) {
                if (data) {
                    this.$(".restore-previous-video[data-youtube-id='" + data.id + "']").replaceWith(
                        this.previousVideoDetailsTemplate(data)
                    );
                }
            }, this));
        }, this));
    },
    onRender: function() {
        this.yt = new video.YoutubeVideo({
            ytID: this.model.get("youtubeEmbed"),
            permitGroupControl: IS_ADMIN,
            showGroupControls: false // We're doing our own controls on event pages.
        });
        if (IS_ADMIN) {
            this.yt.on("renderControls", _.bind(function() {
                this.renderControls();
            }, this));
        }
        this.yt.on("control-video", _.bind(function(args) {
            _.extend(args, {roomId: this.model.getRoomId()});
            this.options.transport.send("control-video", args);
        }, this));

        this.$(".video-player").html(this.yt.el);

        this.setPlayerVisibility(!!this.model.get("youtubeEmbed"));

        if (this.model.get("youtubeEmbed")) {
            this.yt.render();
        } else {
            this.renderControls();
        }
    },
    control: function(args) {
        this.yt.receiveControl(args);
    }
});

return views;
});
