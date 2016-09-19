import _ from 'underscore'
import fs from 'fs'
import google from 'googleapis'
import googleAuth from 'google-auth-library'

let GDrive = function () {

  let PROMISES = 3
  let DRIVE_ROOT = process.env.DRIVE_ROOT
  const SERVICE_CREDENTIALS = JSON.parse(process.env.SERVICE_CREDENTIALS)
  const SCOPES_DRIVE = ['https://www.googleapis.com/auth/drive.metadata.readonly']
  const SCOPES_SHEETS = ['https://www.googleapis.com/auth/spreadsheets']
  let FILES = []
  let FOLDERS = []

  /**
   * Get the array of json objects containing all documents found in the
   * library
   *
   * @param driveRoot Optional: ID of the root folder to traverse
   * @param promises Optional: Number of parallel promises per iteration
   *   (default
   *   3)
   * @returns {Promise} Promise resolves an object {files: [...], paths: [...]}
   */
  function getGDriveDocuments(driveRoot = '', promises = '') {
    if (driveRoot != '') {
      DRIVE_ROOT = driveRoot
    }
    if (promises != '') {
      PROMISES = promises
    }
    if (SERVICE_CREDENTIALS === '') {

    }
    return new Promise((resolve, reject) => {
      const auth = getAuth('drive')
      global.resolveGetDriveDocuments = resolve
      global.rejectGetDriveDocuments = reject
      findFiles(auth)
    })
  }

  /**
   * Get the authentication object for googleapis requests
   *
   * @param use Defines the use of the auth. Valid options are 'drive' and
   *   'sheets'
   * @returns {Object}
   */
  function getAuth(use) {
    const auth = new googleAuth()
    let jwt = new auth.JWT()
    jwt.fromJSON(SERVICE_CREDENTIALS)
    if (use === 'drive') {
      return jwt.createScoped(SCOPES_DRIVE)
    } else if (use === 'sheets') {
      return jwt.createScoped(SCOPES_SHEETS)
    } else {
      console.log(
        `Please use 'drive' or 'sheets' as argument when calling getAuth`)
    }
  }

  /**
   * Get the files from the root and then call getFiles so it can do recursion
   * on them as a starting point.
   *
   * @param auth
   */
  function findFiles(auth) {
    const service = google.drive('v3')
    const query = `'${DRIVE_ROOT}' in parents`
    service.files.list({
                         auth: auth,
                         corpus: 'user',
                         q: query,
                         pageSize: 500,
                         spaces: 'drive'
                       }, (err, response) => {
                         if (err) {
                           rejectGetDriveDocuments(
                             'The API returned an error: ' + err)
                           return
                         }
                         const files = response.files
                         if (files.length == 0) {
                           rejectGetDriveDocuments('No files found in the root')
                         } else {
                           _.forEach(files, (child) => {
                             if (child.mimeType ===
                                 'application/vnd.google-apps.folder') {
                               FOLDERS.push({ path: child.name, id: child.id })
                             }
                           })
                           getFiles(auth, files)
                         }
                       }
    );
  }

  /**
   * Recursively iterates the folder tree and resolves the getGDriveDocuments
   * promise.
   *
   * @param auth
   * @param files
   * @param i
   */
  function getFiles(auth, files, i = 0) {
    console.log('length: ', files.length)
    console.log('i: ', i)
    console.log('-')
    const service = google.drive('v3');
    if (i < files.length) {
      let promisesNumber = PROMISES
      if (i + PROMISES > files.length) {
        promisesNumber = (i + PROMISES) - files.length
      }
      const slice = files.slice(i, i + promisesNumber)
      let promises = []
      _.forEach(slice, function (file) {
        const query = `'${file.id}' in parents`
        promises.push(new Promise((resolve, reject) => {
          service.files.list({
                               auth: auth,
                               corpus: 'user',
                               q: query,
                               pageSize: 1000,
                               spaces: 'drive'
                             }, (err, response) => {
                               if (err) {
                                 return reject('The API returned an error: ' + err)
                               }
                               const fileChildren = response.files;
                               let foundFolders = []
                               if (fileChildren.length > 0) {
                                 _.forEach(fileChildren, (child) => {
                                   if (child.mimeType ===
                                       'application/vnd.google-apps.folder') {
                                     if (file.path) {
                                       child.country = file.country
                                       child.path = `${file.path}/${child.name}`
                                       if (file.fiscalYear) {
                                         child.fiscalYear = file.fiscalYear
                                       } else if (child.path.split('/').length === 3) {
                                         child.fiscalYear = child
                                           .path.split('/')[2]
                                           .match(/\d+/g)
                                         if (child.fiscalYear) {
                                           child.fiscalYear = child.fiscalYear.join()
                                         } else {
                                           child.fiscalYear = ""
                                         }
                                       }
                                     } else {
                                       child.country = file.name
                                       child.path = `${file.name}/${child.name}`
                                     }
                                     foundFolders.push(child)
                                     FOLDERS.push({ path: child.path, id: child.id })
                                   } else {
                                     child.country = file.country
                                     child.path = file.path
                                     child.fiscalYear = file.fiscalYear
                                     child.parentId = file.id
                                     delete child.kind
                                     FILES.push(child)
                                   }
                                 })
                               }
                               resolve(foundFolders)
                             }
          );
        }));
      })
      Promise.all(promises).then(function (res) {
        _.forEach(res, (foundFolders) => {
          files = files.concat(foundFolders)
        })
        getFiles(auth, files, i + promisesNumber)
      }, function (res) {
        rejectGetDriveDocuments(res)
      })
    } else {
      fs.writeFile('driveDocuments2.json', JSON.stringify(FILES));
      resolveGetDriveDocuments({ documents: FILES, paths: FOLDERS })
    }
  }

  /**
   * Populates the initial spreadsheet
   *
   * @param spreadsheetId
   */
  function populateSpreadSheet(spreadsheetId) {
    const auth = getAuth('sheets')
    const sheets = google.sheets('v4')
    getGDriveDocuments().then((res) => {
      let listArray = createListArray(res.documents)
      sheets.spreadsheets.values.update({
                                          auth: auth,
                                          spreadsheetId: spreadsheetId,
                                          range: 'Sheet1',
                                          valueInputOption: 'USER_ENTERED',
                                          resource: {
                                            "range": 'Sheet1',
                                            "majorDimension": "ROWS",
                                            "values": listArray,
                                          }
                                        }, function (err, response) {
        if (err) {
          console.log('The API returned an error: ' + err);
          return;
        }
        console.log(response)
      });

      listArray = createListArray(res.paths)
      sheets.spreadsheets.values.update({
                                          auth: auth,
                                          spreadsheetId: spreadsheetId,
                                          range: 'Sheet2',
                                          valueInputOption: 'USER_ENTERED',
                                          resource: {
                                            "range": 'Sheet2',
                                            "majorDimension": "ROWS",
                                            "values": listArray,
                                          }
                                        }, function (err, response) {
        if (err) {
          console.log('The API returned an error: ' + err);
          return;
        }
        console.log(response)
      });
    })
  }

  /**
   *
   *
   * @param spreadsheetId
   */
  function getSpreadsheetData(spreadsheetId) {
    return new Promise((resolve, reject) => {
      const auth = getAuth('sheets')
      const sheets = google.sheets('v4')
      sheets.spreadsheets.values.get({
                                       auth: auth,
                                       spreadsheetId: spreadsheetId,
                                       range: 'Sheet1',
                                     }, function (err, response) {
        if (err) {
          reject('The API returned an error: ' + err);
          return;
        }
        resolve(response)
      });
    })
  }

  /**
   * Create ListValue array from the provided JSON array.
   * Does not handle nested fields.
   *
   * @param data
   * @returns {Array}
   */
  function createListArray(data) {
    let documents = []
    documents.push(_.keys(data[0]))
    _.forEach(data, (item) => {
      if (item)
      documents.push(_.values(item))
    })
    return documents
  }


  return {
    getSpreadsheetData: getSpreadsheetData
    , populateSpreadSheet: populateSpreadSheet
  }
}

export default new GDrive()