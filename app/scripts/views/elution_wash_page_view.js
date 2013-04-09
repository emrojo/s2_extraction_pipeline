define(['text!extraction_pipeline/html_partials/elution_wash_partial.html'], function (elutionWashPartialHtml) {

  function getKey(e) {
    if (window.event) {
      return window.event.keyCode;
    }
    else if (e) {
      return e.which;
    }
    return null;
  }

  var bindingView = function (owner, jquerySelector) {
    console.log("hello");
    this.owner = owner;
    this.jquerySelector = jquerySelector;

    return this;
  };

  bindingView.prototype.renderView = function (model) {
    if (model !== null) {
      this.model = model;
    }
    else {
      model = this.model;
    }


    var parent = this.jquerySelector();

    // We have to append to the document or events won't register
    parent.empty().
      append(elutionWashPartialHtml);
    var finishButton = parent.find(".finishButton");
    var that = this;

    finishButton.on('click', function (e) {
      that.owner.childDone(that, "elutionFinished", {});
    });

//    $('li').addClass("kit");
//    $('ul p').addClass("kit");
//    $('ul h3').addClass("kit");
  };

  bindingView.prototype.setKitValidState = function (valid) {
    var result = '';
    var jquerySelection = this.jquerySelector();

    if (valid) {
      result = 'This kit is valid for the selected tubes';
      jquerySelection.
        find('.printButton').removeAttr('disabled');
    }
    else {
      result = 'This kit is not valid for the selected tubes';
      jquerySelection.
        find('.printButton').attr('disabled', 'disabled');
    }

    jquerySelection.
      find('.validationText').
      empty().
      append(result);
  };

//
//  ScanBarcodeView.prototype.getError = function(model) {
//    var errorMessage = model.customError;
//    if (!errorMessage && !model.isValid()) {
//      errorMessage = "Invalid barcode entered";
//    }
//    return errorMessage ? '<p class="alert-error">' + errorMessage + '</p>' : '';
//  }


  bindingView.prototype.clear = function () {
    /* clear the view from the current page
     */
    var children = this.jquerySelector().empty();
  };

  return bindingView;

});