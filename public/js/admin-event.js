require([
    "jquery", "underscore", "moment-timezone", "jstz", "models", "auth",
    "bootstrap", "bootstrap-datetimepicker"
], function($, _, moment, jstz, models) {

var event = new models.Event(EVENT_DATA); // EVENT_DATA from template.

$(document).ready(function(){
    var options = {
        // NOTE: the parser fails if there isn't whitespace or punctuation
        // between each component.  You can't do "H:iip", it has to be
        // "H:ii p".  Also note: this should be identical to
        // event.DATE_DISPLAY_FORMAT, which uses moment.js syntax instead.
        format: "DD M d, yyyy H:ii p",
        showMeridian: true,
        forceParse: true,
        pickerPosition: 'bottom-left',
        viewSelect: 'decade',
        todayBtn: true,
        todayHighlight: true,
        autoclose: true,
    }
    if (!event.id) {
        var oneWeekAfter = moment()
            .add('days', 7)
            .second(0)
            .minute(0)
            .format(event.DATE_DISPLAY_FORMAT);
        $("#dateAndTime").val(oneWeekAfter);
        // New events probably shouldn't start in the past. Using -1d allows
        // for timezone differences.
        options.startDate = '-1d';
    }

    // Using http://www.malot.fr/bootstrap-datetimepicker/
    $(".form_datetime").datetimepicker(options);

    // Append timezones to option box.
    var zones = moment.tz.names();
    zones.sort(function(a, b) {
        var aIsAmerica = /^America/.test(a);
        var bIsAmerica = /^America/.test(b);
        if (aIsAmerica != bIsAmerica) {
            return aIsAmerica ? -1 : 1;
        } else {
            return a < b ? -1 : a > b ? 1 : 0;
        }
    });
    zones.unshift("Etc/UTC");
    var frag = document.createDocumentFragment();
    _.each(zones, function(zone) {
        var option = document.createElement("option");
        option.value = zone;
        option.textContent = zone.replace(/_/g, " ");
        if (event.get("timeZoneValue")) {
            if (zone === event.get("timeZoneValue")) {
                option.selected = true;
            }
        }
        frag.appendChild(option);
    });
    $("#timeZoneValue").append(frag);

    if($("#timeZoneValue").val() === "") {
        // Automatic TimeZone Detection of the browser client
        $("#timeZoneValue").val(jstz.determine().name());
    }
});

});
