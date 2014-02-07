define([
    'text!app-components/manifest/_reader.html'
  , 'text!app-components/manifest/_row.html'
  , 'lib/file_handling/manifests'
  , 'app-components/dropzone/dropzone'

  // Loaded in the global namespace after this comment
  , 'lib/jquery_extensions'
], function (componentPartialHtml, sampleRowPartial, CSVParser, DropZone) {
  'use strict';

  var viewTemplate = _.compose($, _.template(componentPartialHtml));
  var rowTemplate  = _.template(sampleRowPartial);

  // Functions that generate will display a particular value based on the type it should be.
  var CellTemplates = {
    select: templateHelper(function(cell, value) {
      return $("<select/>").append(_.map(cell.options, option));

      function option(option) {
        var details = {value: option.trim(), text: option.trim()};
        if (details.value.toUpperCase() === value.trim().toUpperCase()) {
          details["selected"] = "selected";
        }
        return $("<option></option>", details);
      }
    }),

    checkbox: templateHelper(function(cell, value) {
      var checkbox = $("<input type='checkbox' />");
      if (value) { checkbox.attr('checked', 'checked'); }
      return checkbox;
    }),

    span: templateHelper(function(cell, value) {
      return $("<span />").text(value);
    }),

    "boolean": templateHelper(function(cell, value) {
      return $("<span />").text(value ? "Yes" : "No");
    })
  };

  // Functions that, given an element in the order view, will extract the value based on the type it should be.
  var Extractors = {
    checkbox: function(element) { return element.find("input:checkbox:first").is(":checked"); },
    select:   function(element) { return element.find("select:first").val(); },
    span:     function(element) { return element.find("span:first").text(); }
  };

  return function(context) {
    var view = createHtml(context);
    return {
      name: "reader.manifest.s2",
      view: view,
      events: { "reset_view.reception.s2": _.bind(view.reset, view) }
    };
  };

  function createHtml(context) {
    var html = viewTemplate();

    var message = function(type) {
      _.chain(arguments).drop(1).each(function(message) {
        html.trigger(type + ".status.s2", message);
      });
    };
    var error          = _.partial(message, "error");
    var success        = _.partial(message, "success");
    var manifestErrors = function(manifest) { error.apply(this, manifest.errors); return manifest; }

    // saves the selection for performances
    var manifestTable      = html.find(".orderMaker");
    var registration       = html.find("#registrationBtn").hide();
    var registrationHelper = registration.dataHelper("manifest");

    // Configure and establish the dropzone
    var dropzone = DropZone({
      mime: "text/csv",
      message: "Drop the manifest CSV file here, or click to select."
    });
    html.find(".dropzone").append(dropzone.view).on(dropzone.events);
    html.on("dropzone.file", process(html, warningButton(registration, hideUnhide(dropzone.view, function(event, content) {
      return dropZoneLoad(context, registration, manifestTable, content).then(
        _.bind(registrationHelper.manifest, registrationHelper),
        manifestErrors
      );
    }))));

    registration.lockingClick(process(html, hideUnhide(dropzone.view, function(source) {
      return createOrder(context, manifestTable, source.data("manifest")).then(
        success,
        error
      );
    })));

    _.extend(html, {
      reset: function() {
        dropzone.view.show();
        registration.hide();
        manifestTable.empty();
      }
    });
    return html;
  }

  // Functions handling the toggling of rows.
  function nearestRow(event) {
    return $(event.target).closest("tr");
  }
  function disableRow(tr) {
    tr.find("select,input").attr("disabled", true);
    tr.removeClass("success");
    return tr;
  }
  function enableRow(tr) {
    tr.find("select,input").attr("disabled", false);
    tr.addClass("success");
    return tr;
  }
  function enableRowSelector(tr) {
    tr.find("input[data-name_of_column='_SELECTED']").attr("disabled",false);
  }

  // Functions handling the generation of view components.
  function normalView(content) {
    var template = CellTemplates[content.type || 'span'] || CellTemplates.span;
    return template(content);
  }
  function errorView(element) {
    $(element, "select,input").attr("disabled", true);
    return element;
  }
  function elementToHtml(element) {
    return element.wrap("<div/>").parent().html();
  }

  // Some utility functions for dealing with processes
  function displayManifest(registerButton, makeOrderButton, manifest) {
    registerButton.show();
    if (manifest.details.length > 0) {
      createSamplesView(makeOrderButton, manifest);
      makeOrderButton.show();
    }
    return manifest;
  }

  // View related functions
  function updateDisplay(transform, details) {
    details.display = transform(details.row);
    return details;
  }
  function generateView(details) {
    var viewCreators = [normalView];
    if (details.errors.length > 0) viewCreators.unshift(errorView);
    viewCreators.unshift(elementToHtml);
    details.views = _.map(details.display, _.compose.apply(undefined, viewCreators));
    return details;
  }

  function createSamplesView(view, manifest) {
    // Generate the display and then render the view
    var data = { headers: [], manifest: manifest };
    if (manifest.template) {
      _.each(manifest.details, _.compose(generateView, _.partial(updateDisplay, manifest.template.json_template_display)));
      data.headers = _.map(manifest.details[0].display, function(c) { return c.friendlyName || c.columnName; });
    }
    view.append(rowTemplate(data));

    // Deal with checking & unchecking rows for orders
    view.delegate(
      "input[data-name_of_column='_SELECTED']:checked",
      "click",
      _.compose(enableRowSelector, enableRow, nearestRow)
    ).delegate(
      "input[data-name_of_column='_SELECTED']:not(:checked)",
      "click",
      _.compose(enableRowSelector, disableRow, nearestRow)
    );
  }

  function dropZoneLoad(context, registerButton, manifestTable, fileContent) {
    var deferred = $.Deferred();

    // Remove the previous results
    manifestTable.empty();
    return setFileContent(context, fileContent).always(
      _.partial(displayManifest, registerButton, manifestTable)
    ).then(
      _.partial(success, deferred),
      _.partial(failure, deferred)
    );

    function failure(deferred, value) {
      deferred.reject("There are errors with the manifest. Fix these or proceed with caution!");
      return value;
    }
    function success(deferred, value) {
      deferred.resolve(value);
      return value;
    }
  }

  function createOrder(context, manifestTable, manifest) {
    var extractors =
      _.chain(manifest.details[0].display)
       .pluck('type')
       .map(buildExtractor)
       .value();

    var data = manifestTable
    .find("tbody tr.success")
    .map(function() {
      return _.chain(extractors)
      .zip($(this).find("td"))
      .map(function(p) { return p[0](p[1]); })
      .compact()
      .object()
      .value();
    });

    return context.getS2Root().then(_.partial(updateFromManifest, manifest, data));
  }

  function buildExtractor(type) {
    var extractor = Extractors[type || 'span'] || Extractors.span;

    return function(el) {
      var element = $(el);

      var data = element.find(":first").data();
      if (_.isUndefined(data)) return undefined;
      return [data.name_of_column, extractor(element)];
    };
  }

  // TODO: move this into underscore templates
  function templateHelper(callback) {
    return function(cell) {
      var value   = cell.value || cell.default;
      var element = callback(cell, value);
      return element.addClass(cell.class)
                    .attr("data-name_of_column", cell.columnName);
    };
  }

  function setFileContent(context, fileContent) {
    // This is what we are going to fill out: information on each of the samples (the resource itself but also if there is an
    // issue associated with it), and any global errors (missing labels, search errors).
    var manifest = {
      template: undefined,
      errors:   [],
      details:  []
    };
    var resolver = _.partial(resolveSearch, manifest);

    var dataAsArray = CSVParser.from(fileContent);
    if (_.isUndefined(dataAsArray)) {
      manifest.errors.push("The file uploaded does not appear to be a valid manifest.");
      return resolver();
    }

    var templateName       = dataAsArray[2][0]; // always A3 !!
    manifest.template = context.templates[templateName];
    if (_.isUndefined(manifest.template)) {
      manifest.errors.push("Could not find the corresponding template!");
      return resolver();
    }
    manifest.model = manifest.template.model.pluralize();

    var columnHeaders = dataAsArray[manifest.template.manifest.header_line_number];
    if (columnHeaders.length <= 1 && columnHeaders[0]) {
      manifest.errors.push("The file contains no header!");
      return resolver();
    }

    manifest.details =
      _.chain(dataAsArray)
       .drop(manifest.template.manifest.header_line_number+1)
       .filter(manifest.template.emptyRow)
       .map(function(row) { return _.zip(columnHeaders, row); })
       .map(function(pairs) { return _.object(pairs); })
       .map(manifest.template.reader.builder)
       .value();

    if (manifest.details.length <= 0) {
      manifest.errors.push("The file contains no data!");
    }

    // Page through all of the resources from the manifest, checking the information from the manifest against what the
    // system believes should be true.  Once that's done, any resources that were specified in the manifest but not found
    // in the system should be pushed as errors.  Finally, resolve the search appropriately.
    var deferred =
      context.getS2Root()
             .then(_.partial(pageThroughResources, manifest))
             .then(_.partial(pushMissingResourceErrors, manifest))
             .then(_.partial(invalidateManifestIfAllInvalid, manifest))
    return _.regardless(deferred, resolver);
  }

  function updateFromManifest(manifest, dataFromGUI, root) {
    // Transform the GUI & manifest data into the same format and then merge together the structures, overwriting
    // the manifest information with that from the GUI.

    function indexBySangerId(memo, o){
      memo[o.sample.sanger_sample_id] = o.sample;
      return memo;
    }

    var samplesFromGUI = _.chain(dataFromGUI)
    .map(_.compose(_.removeUndefinedKeys, manifest.template.json_template))
    .reduce(indexBySangerId, {})
    .value();

    var samples = _.chain(manifest.details)
    .pluck("row")
    .map(manifest.template.json_template)
    .value();

    var updates = _.map(samples, function(o){
      var update = {};

      update.sample = _.deepMerge(
        _.removeUndefinedKeys(o.sample),
        samplesFromGUI[o.sample.sanger_sample_id]
      );

      return update;
    });

    // Now perform the updates on the samples and the labware in parallel, so that we can save some time on this
    // as these are completely independent.
    return $.when(updateSamples(root, updates), updateLabware(manifest.model, root, updates));
  }

  function updateSamples(root, updates) {
    var sampleUpdates =
      _.chain(updates)
       .pluck('sample')
       .compact()
       .map(markSampleForPublishing)
       .map(function(sample) { return [sample.sanger_sample_id, _.omit(sample,'sanger_sample_id')]; })
       .object()
       .value();

    if (_.isEmpty(sampleUpdates)) return "No updates of sample information required";

    return root.bulk_update_samples
    .create({by: "sanger_sample_id", updates: sampleUpdates})
    .then(_.constant("Samples successfully updated."), _.constant("Could not update the samples in S2."));
  }

  function updateLabware(model, root, updates) {
    var resourceUpdates =
      _.chain(updates)
    .pluck('resource')
    .compact()
    .map(function(u) { return [u.identifier.value, _.omit(u, 'identifier')]; })
    .object()
    .value();

    if (_.isEmpty(resourceUpdates)) return "No updates of resource information required";

    return root.bulk_update_labels.create({
      by: 'identifier',
      labels: resourceUpdates
    }).then(
    _.constant("Labware successfully updated."),
    _.constant("Could not update the labware in S2.")
    );
  }

  // Search for each of the resources in the manifest so that we can process them in pages.  Each page is
  // handled individually, with the entries on the page being handled sequentially.  Therefore, rather
  // than having 1000 simultaneous requests, we get 10 simultaneous requests that are 100 sequential
  // requests.  This should reduce the load on the browser.
  function pageThroughResources(manifest, root) {
    var labels   = _.chain(manifest.details).indexBy(function(v) { return v.label.value; }).keys().value();
    var promises = [];
    return manifest.template.reader.searcher(root[manifest.model], labels).paged(function(page, hasNext) {
      if (page.entries.length == 0) return;
      promises.push($.chain(_.map(page.entries, promiseHandler), _.regardless));
    }).then(function() {
      // Normally we would use '$.when' here but the problem is that we want to wait for all promises
      // to finish, regardless of their reject/resolve status.  $.when will reject immediately upon
      // *one* of the promises being rejected.
      return $.waitForAllPromises(promises);
    })

    function promiseHandler(resource) {
      return function() {
        return updateManifestDetails(root, manifest, resource);
      };
    }
  }

  function updateManifestDetails(root, manifest, resource) {
    var details =
      _.chain(manifest.details)
    .filter(function(details) { return details.label.value === resource.labels[details.label.column].value; })
    .map(function(details) { details.resource = resource; return details; })
    .value();

    if (_.isEmpty(details)) {
      manifest.errors.push("Label '" + resource.labels.barcode.value + "' is not part of the manifest!");
      return $.Deferred().reject();
    } else {
      // Pair up each of the details with the samples that are in the resource.  Then we can lookup
      // the associated sample and check it against the details.
      var sampleUuid = _.compose(sampleFromContainer, _.partial(manifest.template.reader.extractor, resource));
      return $.waitForAllPromises(
        _.chain(details)
        .map(function(details) { return [details,sampleUuid(details)]; })
        .map(_.partial(validateSampleDetails, root, manifest))
        .value()
      );
    }
  }
  function sampleFromContainer(aliquots) {
    if (_.isEmpty(aliquots)) {
      return undefined;
    } else if (_.isUndefined(aliquots[0].sample)) {
      return undefined;
    } else {
      return aliquots[0].sample.uuid;
    }
  }

  function validateSampleDetails(root, manifest, pair) {
    var details = pair[0], uuid = pair[1];
    if (_.isUndefined(uuid)) {
      details.errors.push("Does not appear to be part of the labware!");
      return $.Deferred().reject(details);
    } else {
      return root.samples
      .find(uuid)
      .then(_.partial(checkSample, details))
      .then(_.partial(manifest.template.validation, details));
    }
  }

  // Any labels that were not found need to be marked as being missing.
  function pushMissingResourceErrors(manifest, value) {
    _.each(manifest.details, function(details) {
      if (!_.isUndefined(details.resource)) return;
      details.errors.push("Cannot find these details in the system");
    });
    return value;
  }

  // If all of the rows of the manifest are invalid then we can assume the manifest is invalid!
  function invalidateManifestIfAllInvalid(manifest, value) {
    if (_.chain(manifest.details).pluck('invalid').all(_.identity).value()) {
      manifest.errors.push("All of the rows appear invalid so this manifest is assumed to be invalid");
      manifest.invalid = true;
    }
    return value;
  }

  // If there are any global errors, or any individual resource errors, then we should reject the search.
  function resolveSearch(manifest) {
    var deferred   = $.Deferred();
    var resolution = 'resolve';
    if (manifest.errors.length > 0) {
      resolution = 'reject';
    } else if (_.chain(manifest.details).pluck('errors').flatten().value().length > 0) {
      resolution = 'reject';
    }

    return deferred[resolution](manifest);
  }

  // Checks the details from the manifest about the sample against the sample that is actually present
  // in the resource in the system.
  function checkSample(details, sample) {
    if (sample.sanger_sample_id !== details.sample) {
      details.errors.push("Should contain '" + sample.sanger_sample_id + "' not '" + details.sample + "'");
    }
    return details;
  }

  function markSampleForPublishing(sample) {
    sample.state = "published";
    return sample;
  }

  function warningButton(button, f) {
    return function() {
      button.hide();
      return f.apply(this, arguments).then(function() {
        button.removeClass("btn-warning").prop("disabled", false);
      }, function(value) {
        if (value.invalid || value.errors.length > 0) { button.hide(); }
        button.addClass("btn-warning");
      });
    };
  }

  function hideUnhide(element, f) {
    return function() {
      element.hide();
      return f.apply(this, arguments).fail(_.bind(element.show, element));
    };
  }

  // Wraps a function in the process reporting.
  function process(html, f) {
    var start  = function() { html.trigger("start_process.busybox.s2"); };
    var finish = function() { html.trigger("end_process.busybox.s2"); };

    return function() {
      start();
      return f.apply(this, arguments).always(finish);
    };
  }
});

