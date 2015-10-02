/*************************************************************************
 *
 * ADOBE CONFIDENTIAL
 * ___________________
 *
 *  Copyright 2015 Adobe Systems Incorporated
 *  All Rights Reserved.
 *
 * NOTICE:  All information contained herein is, and remains
 * the property of Adobe Systems Incorporated and its suppliers,
 * if any.  The intellectual and technical concepts contained
 * herein are proprietary to Adobe Systems Incorporated and its
 * suppliers and are protected by trade secret or copyright law.
 * Dissemination of this information or reproduction of this material
 * is strictly forbidden unless prior written permission is obtained
 * from Adobe Systems Incorporated.
 **************************************************************************/

'use strict';

var put = require('put');
var logger = require('winston');
var async = require('async');

var consts = require('../../../constants');
var utils = require('../../../utils');

/**
 * TRANS2_QUERY_PATH_INFORMATION (0x0005): This transaction is used to get information
 * about a specific file or directory.
 *
 * @param {Object} msg - an SMB message object
 * @param {Number} commandId - the command id
 * @param {Buffer} commandParams - the command parameters
 * @param {Buffer} commandData - the command data
 * @param {Object} connection - an SMBConnection instance
 * @param {Object} server - an SMBServer instance
 * @param {Function} cb callback called with the command's result
 * @param {Object} cb.result - an object with the command's result params and data
 *                             or null if the handler already sent the response and
 *                             no further processing is required by the caller
 * @param {Number} cb.result.status
 * @param {Buffer} cb.result.params
 * @param {Buffer} cb.result.data
 */
function handle(msg, commandId, commandParams, commandData, connection, server, cb) {
  var informationLevel = commandParams.readUInt16LE(0);
  var fileName = utils.extractUnicodeBytes(commandParams, 6).toString('utf16le');

  logger.debug('[%s] informationLevel: 0x%s, fileName: %s', consts.TRANS2_SUBCOMMAND_TO_STRING[commandId], informationLevel.toString(16), fileName);

  var result;

  if (informationLevel != consts.SMB_INFO_STANDARD && !msg.header.flags.pathnames.long.supported) {
    result = {
      status: consts.STATUS_INVALID_PARAMETER,
      params: commandParams,
      data: commandData
    };
    process.nextTick(function () { cb(result); });
  }

  var self = this;

  function getFile(callback) {
    server.getTree(msg.header.tid).open(fileName, callback);
  }

  function buildResult(file, callback) {
    var smbCreated = utils.systemToSMBTime(file.getCreatedTime());
    var smbLastModified = utils.systemToSMBTime(file.getLastModifiedTime());
    var smbLastAccessed = utils.systemToSMBTime(file.getLastAccessedTime());
    var smbLastChanged = utils.systemToSMBTime(file.getLastChangedTime());

    var fileNameBytes = new Buffer(file.getName(), 'utf16le');

    var params = informationLevel >= consts.SMB_QUERY_FILE_BASIC_INFO ? new Buffer([ 0x00, 0x00 ]) : utils.EMPTY_BUFFER;

    var dataOut = put();
    switch (informationLevel) {
      case consts.SMB_INFO_STANDARD:
      case consts.SMB_INFO_QUERY_EA_SIZE:
      case consts.SMB_INFO_QUERY_EAS_FROM_LIST:
      case consts.SMB_INFO_QUERY_ALL_EAS:
      case consts.SMB_INFO_IS_NAME_VALID:
        // todo implement
        logger.error('encountered unsupported informationLevel 0x%s', informationLevel.toString(16));
        result = {
          status: consts.STATUS_NOT_IMPLEMENTED,
          params: commandParams,
          data: commandData
        };
        callback(null, result);
        return;

      case consts.SMB_QUERY_FILE_ALL_INFO:
      case consts.SMB_QUERY_FILE_BASIC_INFO:
        dataOut.word32le(smbCreated.getLowBitsUnsigned()) // CreationTime
          .word32le(smbCreated.getHighBitsUnsigned())
          .word32le(smbLastAccessed.getLowBitsUnsigned()) // LastAccessTime
          .word32le(smbLastAccessed.getHighBitsUnsigned())
          .word32le(smbLastModified.getLowBitsUnsigned()) // LastWriteTime
          .word32le(smbLastModified.getHighBitsUnsigned())
          .word32le(smbLastChanged.getLowBitsUnsigned()) // LastChangeTime
          .word32le(smbLastChanged.getHighBitsUnsigned())
          .word32le(file.getAttributes()) // ExtFileAttributes
          .word32le(0); // Reserved
        if (informationLevel != consts.SMB_QUERY_FILE_ALL_INFO) {
          break;
        }
        // fall through
      case consts.SMB_QUERY_FILE_STANDARD_INFO:
        dataOut.word64le(file.getAllocationSize()) //  AllocationSize
          .word64le(file.getDataSize()) //  EndOfFile
          .word32le(1) // NumberOfLinks
          .word8(0)  // DeletePending
          .word8(file.isDirectory() ? 1 : 0);  // Directory
        if (informationLevel != consts.SMB_QUERY_FILE_ALL_INFO) {
          break;
        }
        dataOut.word16le(0);  // Reserved2
        // fall through
      case consts.SMB_QUERY_FILE_EA_INFO:
        dataOut.word32le(0);  // EaSize
        if (informationLevel != consts.SMB_QUERY_FILE_ALL_INFO) {
          break;
        }
        // fall through
      case consts.SMB_QUERY_FILE_NAME_INFO:
        dataOut.word32le(fileNameBytes.length)  // FileNameLength
          .put(fileNameBytes);  // FileName
        break;

      case consts.SMB_QUERY_FILE_STREAM_INFO:
      case consts.SMB_QUERY_FILE_ALT_NAME_INFO:
      case consts.SMB_QUERY_FILE_COMPRESSION_INFO:
        // todo implement
        logger.error('encountered unsupported command 0x%s', informationLevel.toString(16));
        result = {
          status: consts.STATUS_NOT_IMPLEMENTED,
          params: commandParams,
          data: commandData
        };
        callback(null, result);
        return;

      default:
        result = {
          status: consts.STATUS_OS2_INVALID_LEVEL,
          params: commandParams,
          data: commandData
        };
        callback(null, result);
        return;
    }
    var data = dataOut.buffer();
    var result = {
       status: consts.STATUS_SUCCESS,
       params: params,
       data: data
     };
    callback(null, result);
  }

  async.waterfall([ getFile, buildResult ], function (err, result) {
    if (err) {
      logger.error(err);
      cb({
        status: consts.STATUS_UNSUCCESSFUL,
        params: commandParams,
        data: commandData
      });
    } else {
      cb(result);
    }
  });
}

module.exports = handle;