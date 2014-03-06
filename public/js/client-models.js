
// Some slight variations on the models that run only on the client.
// Nothing major, just some events.

define([
   "models"
], function(models) {

models.ClientSessionList = models.SessionList.extend({    

    initialize: function(options) {
        models.SessionList.prototype.initialize.call(this, options);
    },

    comparator: function(a, b) {
        // sort by activity first, then alpha
        if(a.getNumConnectedParticipants() < b.getNumConnectedParticipants()) {
            return 1;
        } else if(b.getNumConnectedParticipants() < a.getNumConnectedParticipants()) {
            return -1;
        } else {
            return a.get("title").localeCompare(b.get("title"));
        }
    }
});

models.ClientEvent = models.Event.extend({
    initialize: function() {
        models.Event.prototype.initialize.call(this);

        this.set("sessions", new models.ClientSessionList(null, this));
    },
});

return models;

});
