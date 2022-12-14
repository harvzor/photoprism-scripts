import { env } from 'process'
import * as yaml from 'js-yaml'
import * as fs from 'fs'
import * as path from 'path'
import crc32c from 'fast-crc32c'
import inquirer from 'inquirer'

import { SidecarFile, SidecarFileRaw, } from './types/sidecarFile'
import * as logger from './logger'

export const removeExtension = (filePath: string): string => {
    return filePath.substring(0, filePath.lastIndexOf('.')) || filePath
}

/**
 * Find files matching the extension name.
 * @param  {string} folder
 * @param  {string} extensionNames Naming including leading dot, example: .yml
 */
export const recursiveSearch = async(folder: string, extensionNames?: string[]): Promise<string[]> => {
    let paths: string[] = []

    try {
        const filesOrFolderNames = await fs.promises.readdir(folder)
        for (const fileOrFolderName of filesOrFolderNames) {
            let fileOrFolderPath = path.join(folder, fileOrFolderName)
            const stat = await fs.promises.stat(fileOrFolderPath)

            if (stat.isFile()) {
                if (extensionNames == undefined || extensionNames.some(x => x == path.extname(fileOrFolderName)))
                    paths.push(fileOrFolderPath)
            } else if (stat.isDirectory()) {
                paths = paths.concat(await recursiveSearch(fileOrFolderPath, extensionNames))
            }
        }
    } catch (err) {
        logger.error(err)
    }

    return paths
}

/**
 * Get the contents of a YAML file.
 */
export const readYamlFile = async(yamlFilePath: string): Promise<SidecarFile> => {
    try {
        const raw = yaml.load(await fs.promises.readFile(yamlFilePath, 'utf8')) as SidecarFileRaw
        const doc = new SidecarFile(raw)

        return doc
    } catch (e) {
        logger.error(e)

        throw e
    }
}

export const findMediaPath = async(yamlPath: string): Promise<string[]> => {
    const result: string[] = []

    if (!yamlPath.startsWith(env.SIDECAR_PATH))
        throw `path doens\'t start correctly, path is ${yamlPath} but should begin with ${env.SIDECAR_PATH}`

    // Assuming that the image exists in the same folder structure as the sidecar.
    const imageLocationDir = path.dirname(
        path.join(
            env.ORIGINALS_PATH,
            yamlPath.substring(env.SIDECAR_PATH.length)
        )
    )

    try {
        // Check if the target dir exists.
        await fs.promises.access(imageLocationDir)
    } catch {
        // Folder does not exist.
        // YAML is an orphan.
        return result
    }

    const potentialMatches = await fs.promises.readdir(imageLocationDir)
    let matchesFound = 0
    for (const potentialMatch of potentialMatches) {
        const stat = await fs.promises.stat(path.join(imageLocationDir, potentialMatch))

        if (stat.isDirectory())
            continue

        // If the file name matches.
        // Could also match multiple times if the image is a burst, such as '20210717_163906_1BF7A639.00002.jpg'.
        // If a burst is detected, there will only be one YAML file called ''20210717_163906_1BF7A639.yml'.
        // BUG: if it's a stack, and the stack is not a burst but similar pictures (but not just different filetypes), then the images will have their own hashes, different to the hash of the yaml file.
        if (removeExtension(potentialMatch).startsWith(removeExtension(path.basename(yamlPath)))) {
            result.push(path.join(imageLocationDir, potentialMatch))
            matchesFound++
        }
    }

    return result
}

/**
 * Group a yaml path with its media files.
 */
interface YamlAndMediaPath {
    yamlPath: string,
    /**
     *  Array because it could be a stack.
     */
    mediaPaths: string[],
}

export const findMediaPaths = async function(yamlPaths: string[]): Promise<YamlAndMediaPath[]> {
    let result: YamlAndMediaPath[] = []

    for (const yamlPath of yamlPaths) {
        result.push({
            yamlPath: yamlPath,
            mediaPaths: await findMediaPath(yamlPath)
        })
    }

    return result
}

export const findOrphanedYamlFiles = async function(yamlPaths: string[]): Promise<string[]> {
    const orphanYamlPaths = []
    const mediaFiles = await recursiveSearch(env.ORIGINALS_PATH)

    logger.log(`Found ${mediaFiles.length} files in ${env.ORIGINALS_PATH}`)

    for (let yamlPath of yamlPaths) {
        // If the file name matches.
        // Could also match multiple times if the image is a burst, such as '20210717_163906_1BF7A639.00002.jpg'.
        // If a burst is detected, there will only be one YAML file called ''20210717_163906_1BF7A639.yml'.
        if (!mediaFiles.some(mediaFile => path.basename(yamlPath).split('.')[0] === path.basename(mediaFile).split('.')[0])) {
            orphanYamlPaths.push(yamlPath)
            logger.log(yamlPath)
        }
    }

    return orphanYamlPaths
}

export const findMediaFiles = async(yamlPaths: string[], filterFunction?: Function): Promise<YamlAndMediaPath[]> => {
    let matchingYamlPaths: string[] = []

    if (filterFunction != undefined) {
        for (const yamlPath of yamlPaths) {
            const yamlFile = await readYamlFile(yamlPath)

            if (filterFunction(yamlFile)) {
                matchingYamlPaths.push(yamlPath)
            }
        }
    } else {
        matchingYamlPaths = yamlPaths
    }

    logger.log(`Found ${matchingYamlPaths.length} YAML files`)
    const matchingImagePaths = await findMediaPaths(matchingYamlPaths)
    logger.log(`Found ${matchingImagePaths.length} media files`)

    // Actually not a good check since burst images can find multiples (many images to one YAML).
    if (matchingYamlPaths.length > matchingImagePaths.length) {
        logger.error(`That means there's ${matchingYamlPaths.length - matchingImagePaths.length} media files missing?`)
    }

    return matchingImagePaths
}

export const findMediaFilesAndMoveToTarget = async function(yamlPaths: string[], targetFolderName: string, filterFunction: Function) {
    const matchingImagePaths = await findMediaFiles(yamlPaths, filterFunction) 

    await moveFilesToTargetWithPrompt(
        matchingImagePaths.map(x => x.mediaPaths).flat(),
        path.join(env.ORIGINALS_PATH, targetFolderName)
    )
}

/**
 * @param  {string[]} filePaths Full paths.
 * @param  {string} targetDir Base path of where the files should be moved.
 * @param  {string?} oldDir If defined, the the file will be moved from the old path, but retain the structure excluding the oldDir.
 * @param  {boolean} shouldPrompt If false, do not prompt.
 */
export const moveFilesToTargetWithPrompt = async (filePaths: string[], targetDir: string, oldDir?: string, shouldPrompt = true) => {
    // TODO: could also check that the files to be moved even exist
    const filePathsThatNeedMoving = filePaths
        // No need to move as the file is already there.
        .filter(filePath => path.dirname(filePath) != targetDir)

    logger.log(`Found ${filePathsThatNeedMoving.length} files that need moving`)

    let i = 1
    for (const oldFilePath of filePathsThatNeedMoving) {
        const newFilePath = path.join(
            targetDir,
            oldDir
                ? path.dirname(
                    // oldFilePath may be: photoprism-test/data/storage/sidecar/example/IMG_20220804_113018.yml
                    // so strip photoprism-test/data/storage/sidecar/ to get just example/IMG_20220804_113018.yml
                    oldFilePath.replace(oldDir, '')
                )
                : '',
            path.basename(oldFilePath)
        )

        await moveFileWithPrompt(
            "Move",
            oldFilePath,
            newFilePath,
            shouldPrompt,
            (value: boolean) => shouldPrompt = value,
            i,
            filePathsThatNeedMoving.length
        )

        i++
    }

    logger.log(`---`)
    logger.log(`Finished moving files`)
    logger.log(`---`)
}

export const moveFilesWithPrompt = async(
    action: string,
    currentAndTargetPaths: CurrentAndTargetPath[],
    shouldPrompt: boolean,
    // Umm super ugly but only way I can have this function only doing 1 file at a time?
    setShouldPrompt: Function
) => {
    let i = 1
    for (const currentAndTargetPath of currentAndTargetPaths) {
        moveFileWithPrompt(
            action,
            currentAndTargetPath.currentPath,
            currentAndTargetPath.targetPath,
            shouldPrompt,
            setShouldPrompt,
            i,
            currentAndTargetPaths.length
        )

        i++
    }
}

export const moveFileWithPrompt = async function(
    action: string,
    oldFilePath: string,
    newFilePath: string,
    shouldPrompt: boolean,
    // Umm super ugly but only way I can have this function only doing 1 file at a time?
    setShouldPrompt: Function,
    currentIteration: number,
    totalIterations: number
) {
    const choices = [
        action,
        'Don\'t ' + action,
        action + ' all (auto)',
    ]

    const rename = async function() {
        await fs.promises.rename(oldFilePath, newFilePath)
    }

    const targetDir = path.dirname(newFilePath)
    if (!fs.existsSync(targetDir)) {
        logger.log(`Target folder does not exist, creating ${targetDir}`)
        await fs.promises.mkdir(targetDir, { recursive: true, })
    }

    logger.log(`---`)
    logger.log(`${currentIteration}/${totalIterations}`)
    logger.log(`${action} file`)
    logger.log(`| from ${oldFilePath}`)
    logger.log(`| to   ${newFilePath}`)

    if (!shouldPrompt) {
        await rename()
    } else {
        await inquirer
            .prompt({
                name: 'select',
                message: `${action} file?`,
                type: 'list',
                choices: choices,
            })
            .then(answers => {
                switch(answers.select) {
                    case choices[0]:
                        rename()
                        break;
                    case choices[1]:
                        logger.log(`NOT ${action}ing file`)
                        break;
                    case choices[2]:
                        setShouldPrompt(true)
                        rename()
                        break;
                    default:
                        throw 'Unhandled input'
                }   
            })
    }
}

/**
 * TODO: write a primary image finder for stacks where the images appear similar or are sequential images.
 */
export const findPrimaryImageForStackOfDifferentFileTypes = (mediaPaths: string[]): string | null => {
    let mainMediaPath = null

    for (const mediaPath of mediaPaths) {
        const extName = path.extname(mediaPath).toLocaleLowerCase()

        if (mainMediaPath == null
            && (
                extName == '.jpg'
                || extName == 'jpeg'
            )
        ) {
            mainMediaPath = mediaPath
        } else if (extName == '.raw') {
            mainMediaPath = mediaPath
        } else if (extName == '.heif') {
            mainMediaPath = mediaPath
        } else if (extName == '.png' || extName == '.gif') {
            mainMediaPath = mediaPath
        } else if (extName == '.mp4' || extName == '.webm' || extName == '.mkv') {
            mainMediaPath = mediaPath
        } else if (mainMediaPath != null
            && (
                extName == '.jpg'
                || extName == 'jpeg'
            )
        ) {
            const mainExtName = path.extname(mainMediaPath).toLocaleLowerCase()
            if (mainExtName == '.jpg' || mainExtName== 'jpeg') {
                if (path.basename(mainMediaPath).length > path.basename(mediaPath).length) {
                    mainMediaPath = mediaPath
                }
            }
        }
    }

    // Original Go code from PhotoPrism:
    // if result.Main == nil && f.IsJpeg() {
    //     result.Main = f
    // } else if f.IsRaw() {
    //     result.Main = f
    // } else if f.IsHEIF() {
    //     isHEIF = true
    //     result.Main = f
    // } else if f.IsImageOther() {
    //     result.Main = f
    // } else if f.IsVideo() && !isHEIF {
    //     result.Main = f
    // } else if result.Main != nil && f.IsJpeg() {
    //     if result.Main.IsJpeg() && len(result.Main.FileName()) > len(f.FileName()) {
    //         result.Main = f
    //     }
    // }

    return mainMediaPath
}

/**
 * Auto rename the files trying to use the same pattern that Photoprism uses.
 * Useful for if you:
 * - index media (rather than importing) which doesn't rename files.
 * - change the date of a media file, the name is not auto-updated in Photoprism.
 */
export const renameMediaFilesWithPrompt = async function(yamlPaths: string[], shouldPrompt = true) {
    interface CurrentAndTargetFile {
        currentMediaPath: string,
        targetFileName: string,
    }
    const currentAndTargetFiles: CurrentAndTargetFile[] = []

    for (const yamlPath of yamlPaths) {
        const mediaPaths = await findMediaPath(yamlPath)

        if (mediaPaths.length === 0)
            return false

        const primaryMediaPath = findPrimaryImageForStackOfDifferentFileTypes(mediaPaths)!

        const sidecarFile = await readYamlFile(yamlPath)
        // example: 20030711_140833_0F7C9F04.yml
        // Okay to use TakenAt and not Year/Month/Day - these properties are kept synced.
        const dateString = sidecarFile.TakenAtDateTime!.toFormat('yyyyMMdd_HHmmss_')

        const fileBuffer = await fs.promises.readFile(primaryMediaPath)
        const hash = crc32c.calculate(fileBuffer)
            // To hexadecimal
            .toString(16)
            .toUpperCase()

        const targetFileName = dateString + hash

        // Could be a stack.
        // BUG: if an image is stacked because it's a burst image (and has a name like 01 or 02 on the end), then the images will have the same hash except for the image number.
        // BUG: if an image is stacked because it looks similar, then it will have a different hash but the same yaml file? and the yaml will have the hash of the primary image.
        for (const mediaPath of mediaPaths) {
            const currentFileName = removeExtension(path.basename(mediaPath))

            if (currentFileName != targetFileName) {
                currentAndTargetFiles.push({
                    currentMediaPath: mediaPath,
                    targetFileName: targetFileName,
                })
            }
        }
    }

    let i = 1
    for (const currentAndTargetFile of currentAndTargetFiles) {
        const fileDir = path.dirname(currentAndTargetFile.currentMediaPath)
        const extension = path.extname(currentAndTargetFile.currentMediaPath)
        const newFilePath = path.join(fileDir, currentAndTargetFile.targetFileName + extension)

        await moveFileWithPrompt(
            "Rename",
            currentAndTargetFile.currentMediaPath,
            newFilePath,
            shouldPrompt,
            (value: boolean) => shouldPrompt = value,
            i,
            currentAndTargetFiles.length
        )

        i++
    }

    logger.log(`---`)
    logger.log(`Finished renaming files`)
    logger.log(`---`)
}

interface CurrentAndTargetPath {
    currentPath: string,
    targetPath: string,
}

/**
 * Auto move the media into the correct folder structure.
 * Useful for if you:
 * - index media (rather than importing) which retains the file/folder structure.
 * - change the date of a media file, the media file is not moved into the correct location in the folder structure.
 */
export const findMediaThatNeedsMoving = async(yamlAndMediaPaths: YamlAndMediaPath[]): Promise<CurrentAndTargetPath[]> => {
    const toBeMoved: CurrentAndTargetPath[] = []

    for (const yamlAndMediaPath of yamlAndMediaPaths) {
        const sidecarFile = await readYamlFile(yamlAndMediaPath.yamlPath)

        if (sidecarFile.Private || sidecarFile.DeletedAt !== undefined)
            continue

        const month = sidecarFile.TakenAtDateTime!.month
        const mediaPathDirShouldBe = path.join(
            sidecarFile.TakenAtDateTime!.year.toString(),
            month < 10
                ? '0' + month
                : month.toString(),
        )

        for (const mediaPath of yamlAndMediaPath.mediaPaths) {
            path.basename(mediaPath)
            const mediaPathShouldBe = path.join(
                env.ORIGINALS_PATH,
                mediaPathDirShouldBe,
                path.basename(mediaPath)
            )

            if (mediaPath != mediaPathShouldBe) {
                toBeMoved.push({
                    currentPath: mediaPath,
                    targetPath: mediaPathShouldBe,
                })
            }
        }
    }

    return toBeMoved
}
