define([
  'models/base_page_model'
  , 'mapper/operations'
  , 'lib/file_handling/manifests'
  , 'lib/reception_templates'
], function (BasePageModel, Operations, CSVParser, ReceptionTemplate) {
  'use strict';

  var ReceptionModel = Object.create(BasePageModel);

  $.extend(ReceptionModel, {

    init: function (owner, config) {
      this.owner = owner;
      this.config = config;
      return this;
    },

    reset: function () {
      this.template = undefined;
      this.manifest = undefined;
    },

    setFileContent: function (fileContent) {
      var thisModel   = this;
      var dataAsArray = CSVParser.from(fileContent);

      var templateName = dataAsArray[2][0]; // always A3 !!
      var template     = ReceptionTemplate[templateName];
      if (_.isUndefined(template)) {
        manifestInfo.errors.push("Could not find the corresponding template!");
      }

      var columnHeaders = dataAsArray[template.header_line_number];
      if (columnHeaders.length <= 1 && columnHeaders[0]) {
        manifestInfo.errors.push("The file contains no header!");
      }

      var tubeDetails =
        _.chain(dataAsArray)
         .drop(template.header_line_number+1)
         .filter(_.first)
         .map(function(row) { return _.zip(columnHeaders, row); })
         .map(function(pairs) { return _.object(pairs); })
         .map(buildTubeDetailsForRow)
         .value();

      // This is what we are going to fill out: information on each of the tubes (the tube itself but also if there is an
      // issue associated with it), and any global errors (missing barcodes, search errors).
      var manifestInfo = {
        errors: [],
        tubes:  tubeDetails
      };
      if (tubeDetails.length <= 0) {
        manifestInfo.errors.push("The file contains no data!");
      }

      // Page through all of the tubes from the manifest, checking the information from the manifest against what the
      // system believes should be true.  Once that's done, any tubes that were specified in the manifest but not found
      // in the system should be pushed as errors.  Finally, resolve the search appropriately.
      return this.owner
                 .getS2Root()
                 .then(_.partial(pageThroughTubes, manifestInfo))
                 .then(_.partial(pushMissingTubeErrors, manifestInfo))
                 .then(_.partial(resolveSearch, manifestInfo))
                 .always(maintainInformation);

      // TODO: this is 2 functions: save state, resolve
      function maintainInformation() {
        // we only save the details once we're certain that the data are correct!
        thisModel.manifest     = manifestInfo;
        thisModel.template     = template;
        return thisModel;
      }
    },

    updateSamples: function (dataFromGUI) {
      // Transform the GUI & manifest data into the same format
      var samplesFromGUI = _.map(dataFromGUI, _.compose(removeUndefinedKeys, this.template.json_template));
      var samples        = _.map(_.pluck(this.manifest.tubes, 'row'), this.template.json_template);
      var lookup         = _.partial(_.findBy, 'sanger_sample_id', samples);

      // Pair up the samples selected in the GUI with their manifest partners.  Merge the
      // former into the latter and mark the new sample as published.  Then build an
      // object that details the updates to perform.
      var updates =
        _.chain(samplesFromGUI)
         .pairwise(lookup)
         .map(function(pair) { return _.deepMerge.apply(undefined, pair); })
         .map(markSampleForPublishing)
         .map(function(sample) { return [sample.sanger_sample_id, _.omit(sample,'sanger_sample_id')]; })
         .object()
         .value();

      var deferred = $.Deferred();
      var thisModel = this;

      thisModel.owner
               .getS2Root()
               .then(_.partial(updateSamplesInS2, updates))
               .then(function () {
                 return deferred.resolve(thisModel);
               }, function() {
                 return deferred.reject({message: "Couldn't update the samples on S2."});
               });

      return deferred.promise();
    }
  });

  // Search for each of the tubes in the manifest so that we can process them in pages.  Each page is
  // handled individually, with the entries on the page being handled sequentially.  Therefore, rather
  // than having 1000 simultaneous requests, we get 10 simultaneous requests that are 100 sequential
  // requests.  This should reduce the load on the browser.
  function pageThroughTubes(manifestInfo, root) {
    var barcodes = _.pluck(manifestInfo.tubes, 'barcode');
    var promises = [];
    return root.tubes.searchByBarcode().ean13(barcodes).paged(function(page, hasNext) {
      if (page.entries.length == 0) return;
      promises.push(chain(_.map(page.entries, promiseHandler), _.regardless));
    }).then(function() {
      // Normally we would use '$.when' here but the problem is that we want to wait for all promises
      // to finish, regardless of their reject/resolve status.  $.when will reject immediately upon
      // *one* of the promises being rejected.
      return chain(_.map(promises, _.partial(_.partial, _.identity)), _.regardless);
    })

    function promiseHandler(tube) {
      return function() {
        return updateManifestDetails(root, manifestInfo, tube);
      };
    }
  }

  // Any barcodes that were not found need to be marked as being missing.
  function pushMissingTubeErrors(manifestInfo, value) {
    _.each(manifestInfo.tubes, function(tube) {
      if (!_.isUndefined(tube.resource)) return;
      tube.errors.push("Cannot find this barcode in the system");
    });
    return value;
  }

  // If there are any global errors, or any individual tube errors, then we should reject the search.
  function resolveSearch(manifestInfo) {
    var deferred   = $.Deferred();
    var resolution = 'resolve';
    if (manifestInfo.errors.length > 0) {
      resolution = 'reject';
    } else if (_.chain(manifestInfo.tubes).pluck('errors').flatten().value().length > 0) {
      resolution = 'reject';
    }

    return deferred[resolution](manifestInfo);
  }

  function updateManifestDetails(root, manifestInfo, tube) {
    var tubeDetails = _.find(manifestInfo.tubes, function (details) {
      return details.barcode === tube.labels.barcode.value;
    });

    if (_.isUndefined(tubeDetails)) {
      manifestInfo.errors.push("Tube '" + tube.labels.barcode.value + "' is not part of the manifest!");
      return $.Deferred().reject();
    } else {
      tubeDetails.resource = tube;
      return root.samples
                 .find(tube.aliquots[0].sample.uuid)
                 .then(_.partial(checkSample, tubeDetails));
    }
  }

  // Checks the details from the manifest about the sample against the sample that is actually present
  // in the tube in the system.
  function checkSample(tubeDetails, sample) {
    if (sample.sanger_sample_id !== tubeDetails.sample) {
      tubeDetails.errors.push("Should contain '" + sample.sanger_sample_id + "' not '" + tubeDetails.sample + "'");
    }

    var gender = tubeDetails.row['GENDER'];
    if (_.isUndefined(gender) || !_.isString(gender) || (gender.trim() === '')) {
      tubeDetails.errors.push("Gender is invalid");
    }
    return sample;
  }

  // recursively remove undefined keys from this JS object
  function removeUndefinedKeys(object) {
    return _.reduce(object, function (memo, value, key) {
      if ($.isPlainObject(value)) {
        value = removeUndefinedKeys(value);
      }
      if (value && !($.isEmptyObject(value))) {
        memo[key] = value;
      }
      return memo;
    }, {});
  }

  function updateSamplesInS2(updates, root) {
    return root.bulk_update_samples.create({by: "sanger_sample_id", updates: updates});
  }

  function markSampleForPublishing(sample) {
    sample["state"] = "published";
    return sample;
  }

  function chain(handlers, chaining) {
    if (handlers.length == 0) return;   // It's fair to assume this is an immediate return of undefined!

    var args = _.drop(arguments, 2);
    return _.chain(handlers).drop(1).reduce(chaining, handlers[0].apply(handlers[0], args)).value();
  }

  function buildTubeDetailsForRow(row) {
    return {
      row:      row,
      barcode:  row['Tube Barcode'],
      sample:   row['SANGER SAMPLE ID'],
      resource: undefined,
      errors:   []
    };
  }

  return ReceptionModel;
});
