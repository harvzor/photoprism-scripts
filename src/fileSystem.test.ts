import { jest } from '@jest/globals'
import { fs, vol } from 'memfs'
let env = process.env
// import { env } from 'process'

jest.mock('./logger')
jest.mock('fs')
jest.mock('fs/promises')

import {
    recursiveSearch,
    removeExtension,
    readYamlFile,
    findMediaPath,
    moveFilesToTargetWithPrompt,
    findOrphanedYamlFiles,
    findMediaFiles,
    findPrimaryImageForStackOfDifferentFileTypes,
    findMediaThatNeedsMoving,
    moveFileWithPrompt,
    renameMediaFilesWithPrompt,
} from "./fileSystem"
import { SidecarFile } from './types/sidecarFile'

describe(removeExtension, () => {
    test('png image', () => {
        expect(removeExtension('file.png')).toBe('file')
    })

    test('relative path', () => {
        expect(removeExtension('./path/to/file.png')).toBe('./path/to/file')
    })

    test('absolute path', () => {
        expect(removeExtension('/path/to/file.png')).toBe('/path/to/file')
    })

    test('no extension', () => {
        expect(removeExtension('file')).toBe('file')
    })

    test('2 extensions', () => {
        expect(removeExtension('file.png.zip')).toBe('file.png')
    })
})

describe(recursiveSearch, () => {
    beforeEach(() => {
        vol.reset()
    })

    test('find images', async () => {
        vol.fromJSON({
            './foo.jpg': '',
            './bar/baz.png': '',
        }, '/app');

        const foundPaths = await recursiveSearch('/app/')

        expect(foundPaths.length).toBe(2)
        expect(foundPaths[1]).toBe('/app/foo.jpg')
        expect(foundPaths[0]).toBe('/app/bar/baz.png')
    })

    test('filter', async () => {
        vol.fromJSON({
            './foo.jpg': '',
            './bar.png': '',
        }, '/app');

        const foundPaths = await recursiveSearch('/app/', ['.png'])

        expect(foundPaths.length).toBe(1)
        expect(foundPaths[0]).toBe('/app/bar.png')
    })
})

describe(readYamlFile, () => {
    beforeEach(() => {
        vol.reset()
    })

    test('find images', async () => {
        vol.fromJSON({
            './foo.yml': `TakenAt: 2016-01-10T10:15:06Z
TakenSrc: meta
UID: pr9tsib2qf7dfegc
Type: image
Title: Long Crendon / United Kingdom / 2016
Description: 4 N5 O0.00 Y0.50 C4.50 YT1 CT3 S300   FM0   FC111111111:zzzzzz0 b1f8
  078043874441663838014c0 bac102 e91fba1e40 cb1f7a1de3 ad1f4b1d71 8f1f551c71 d71f031bfe
  e01fb11d22 e91fd21d1b f21fbf1cf9 fb201d1d6810420771d4b fb208a1dd8
DescriptionSrc: meta
Private: true
TimeZone: Europe/London
PlaceSrc: estimate
Year: 2016
Month: 1
Day: 10
ISO: 2200
Exposure: 1/10
FNumber: 1.8
FocalLength: 4
Quality: 3
Details:
  Keywords: grey, main
  Notes: 4 N5 O0.00 Y0.50 C4.50 YT1 CT3 S300   FM0   FC111111111:zzzzzz0 b1f8 078043874441663838014c0
    bac102 e91fba1e40 cb1f7a1de3 ad1f4b1d71 8f1f551c71 d71f031bfe e01fb11d22 e91fd21d1b
    f21fbf1cf9 fb201d1d6810420771d4b fb208a1dd8
  NotesSrc: meta
CreatedAt: 2022-04-04T17:27:47Z
UpdatedAt: 2022-08-05T18:13:53.532791426Z`
        }, '/app');

        const data = await readYamlFile('/app/foo.yml')

        expect(data.TakenAt).toEqual(new Date('2016-01-10T10:15:06Z'))
    })
})

describe(findMediaPath, () => {
    const envBackup = env

    beforeEach(() => {
        jest.resetModules()
        vol.reset()
        env.ORIGINALS_PATH = '/app/originals/'
        env.SIDECAR_PATH = '/app/storage/sidecar/'
    })

    afterEach(() => {
        env = envBackup
    })

    test('find single', async() => {
        vol.fromJSON({
            './storage/sidecar/foo.yml': '',
            './originals/foo.png': '',
        }, '/app');

        const mediaPath = await findMediaPath('/app/storage/sidecar/foo.yml')

        expect(mediaPath.length).toBe(1)
        expect(mediaPath[0]).toBe('/app/originals/foo.png')
    })

    test('find in folders', async() => {
        vol.fromJSON({
            './storage/sidecar/subdir/foo.yml': '',
            './originals/subdir/foo.png': '',
        }, '/app');

        const mediaPath = await findMediaPath('/app/storage/sidecar/subdir/foo.yml')

        expect(mediaPath.length).toBe(1)
        expect(mediaPath[0]).toBe('/app/originals/subdir/foo.png')
    })

    test('find stack', async() => {
        vol.fromJSON({
            './storage/sidecar/foo.yml': '',
            './originals/foo.png': '',
            './originals/foo.jpg': '',
        }, '/app');

        const mediaPath = await findMediaPath('/app/storage/sidecar/foo.yml')

        expect(mediaPath.length).toBe(2)
        expect(mediaPath[0]).toBe('/app/originals/foo.jpg')
        expect(mediaPath[1]).toBe('/app/originals/foo.png')
    })

    test('do not find', async() => {
        vol.fromJSON({
            './storage/sidecar/foo.yml': '',
            './originals/subdir/foo.png': '',
        }, '/app');

        const mediaPath = await findMediaPath('/app/storage/sidecar/foo.yml')

        expect(mediaPath.length).toBe(0)
    })
})

describe(findOrphanedYamlFiles, () => {
    const envBackup = env

    beforeEach(() => {
        jest.resetModules()
        vol.reset()
        env.ORIGINALS_PATH = '/app/originals/'
        env.SIDECAR_PATH = '/app/storage/sidecar/'
    })

    afterEach(() => {
        env = envBackup
    })

    test('find none', async() => {
        vol.fromJSON({
            './originals/foo.png': '',
            './storage/sidecar/foo.yml': '',
        }, '/app');

        const orphanedYamlFiles = await findOrphanedYamlFiles(['/app/storage/sidecar/foo.yml'])

        expect(orphanedYamlFiles.length).toBe(0)
    })

    test('find one', async() => {
        vol.fromJSON({
            // Image has different name.
            './originals/foo.png': '',
            './storage/sidecar/subdir/bar.yml': '',
        }, '/app');

        const orphanedYamlFiles = await findOrphanedYamlFiles(['/app/storage/sidecar/subdir/bar.yml'])

        expect(orphanedYamlFiles.length).toBe(1)
        expect(orphanedYamlFiles[0]).toBe('/app/storage/sidecar/subdir/bar.yml')
    })
})

describe(findMediaFiles, () => {
    const envBackup = env

    beforeEach(() => {
        jest.resetModules()
        vol.reset()
        env.ORIGINALS_PATH = '/app/originals/'
        env.SIDECAR_PATH = '/app/storage/sidecar/'
    })

    afterEach(() => {
        env = envBackup
    })

    test('find one', async() => {
        vol.fromJSON({
            './originals/foo.png': '',
            './storage/sidecar/foo.yml': '',
        }, '/app');

        const mediaFiles = await findMediaFiles(['/app/storage/sidecar/foo.yml'])

        expect(mediaFiles.length).toBe(1)
        expect(mediaFiles[0].mediaPaths.length).toBe(1)
        expect(mediaFiles[0].mediaPaths[0]).toBe('/app/originals/foo.png')
    })

    test('find one - filtered by private', async() => {
        vol.fromJSON({
            './originals/foo.png': '',
            './storage/sidecar/foo.yml': '',
            './originals/bar.png': '',
            './storage/sidecar/bar.yml': 'Private: true',
        }, '/app');

        const mediaFiles = await findMediaFiles(
            ['/app/storage/sidecar/foo.yml', '/app/storage/sidecar/bar.yml'],
            (file: SidecarFile) => file.Private
        )

        expect(mediaFiles.length).toBe(1)
        expect(mediaFiles[0].mediaPaths.length).toBe(1)
        expect(mediaFiles[0].mediaPaths[0]).toBe('/app/originals/bar.png')
    })
})

describe(moveFileWithPrompt, () => {
    beforeEach(() => {
        vol.reset()
    })

    test('move', async() => {
        vol.fromJSON({
            './foo.png': '',
        }, '/app');

        await moveFileWithPrompt(
            "Action",
            '/app/foo.png',
            '/app/subdir/foo.png',
            false,
            () => {},
            1,
            1
        )

        await expect(vol.promises.access('/app/foo.png')).rejects.toThrow()
        await expect(vol.promises.access('/app/subdir/foo.png')).resolves.not.toThrow()
    })

    test('move 2 subdirs down', async() => {
        vol.fromJSON({
            './foo.png': '',
        }, '/app');

        await moveFileWithPrompt(
            "Action",
            '/app/foo.png',
            '/app/subdir1/subdir2/foo.png',
            false,
            () => {},
            1,
            1
        )

        await expect(vol.promises.access('/app/foo.png')).rejects.toThrow()
        await expect(vol.promises.access('/app/subdir1/subdir2/foo.png')).resolves.not.toThrow()
    })
})

describe(moveFilesToTargetWithPrompt, () => {
    beforeEach(() => {
        vol.reset()
    })

    test('move single', async() => {
        vol.fromJSON({
            './foo.png': '',
        }, '/app');

        await moveFilesToTargetWithPrompt(['/app/foo.png'], '/app/target/', undefined, false)

        await expect(vol.promises.access('/app/foo.png')).rejects.toThrow()
        await expect(vol.promises.access('/app/target/foo.png')).resolves.not.toThrow()
    })

    test('move many', async() => {
        vol.fromJSON({
            './foo.png': '',
            './bar.jpg': '',
        }, '/app');

        await moveFilesToTargetWithPrompt(['/app/foo.png', '/app/bar.jpg'], '/app/target/', undefined, false)

        await expect(vol.promises.access('/app/foo.png')).rejects.toThrow()
        await expect(vol.promises.access('/app/bar.jpg')).rejects.toThrow()
        await expect(vol.promises.access('/app/target/foo.png')).resolves.not.toThrow()
        await expect(vol.promises.access('/app/target/bar.jpg')).resolves.not.toThrow()
    })

    test('move from folder', async() => {
        vol.fromJSON({
            './subdir/foo.png': '',
        }, '/app');

        await moveFilesToTargetWithPrompt(['/app/subdir/foo.png'], '/app/target/', undefined, false)

        await expect(vol.promises.access('/app/subdir/foo.png')).rejects.toThrow()
        await expect(vol.promises.access('/app/target/foo.png')).resolves.not.toThrow()
    })

    test('do not move', async() => {
        vol.fromJSON({
            './foo.png': '',
        }, '/app');

        // Extension is different.
        await expect(moveFilesToTargetWithPrompt(['/app/foo.jpg'], '/app/target/', undefined, false)).rejects.toThrowError()

        // File shouldn't have moved.
        await expect(vol.promises.access('/app/foo.png')).resolves.not.toThrow()
        // New file should not have been created.
        await expect(vol.promises.access('/app/target/foo.png')).rejects.toThrow()
    })
})

describe(findPrimaryImageForStackOfDifferentFileTypes, () => {
    test('jpg vs png', async() => {
        const primaryImage = findPrimaryImageForStackOfDifferentFileTypes([
            '/foo.jpg',
            '/foo.png',
        ])

        expect(primaryImage).toBe('/foo.png')
    })

    test('png vs jpg', async() => {
        const primaryImage = findPrimaryImageForStackOfDifferentFileTypes([
            '/foo.jpg',
            '/foo.png',
        ])

        expect(primaryImage).toBe('/foo.png')
    })

    // Don't know why though.
    test('jpg with shorter name should be preferred', async() => {
        const primaryImage = findPrimaryImageForStackOfDifferentFileTypes([
            '/foo.jpg',
            '/foo (2).jpg',
        ])

        expect(primaryImage).toBe('/foo.jpg')
    })
})

describe(findMediaThatNeedsMoving, () => {
    const envBackup = env

    beforeEach(() => {
        jest.resetModules()
        vol.reset()
        env.ORIGINALS_PATH = '/app/originals/'
        env.SIDECAR_PATH = '/app/storage/sidecar/'
    })

    afterEach(() => {
        env = envBackup
    })

    test('should reorganise', async() => {
        vol.fromJSON({
            './originals/foo.png': '',
            './storage/sidecar/foo.yml': `TakenAt: 2016-01-01T12:00:00Z
Private: false
Archived: false`,
        }, '/app');

        const organised = await findMediaThatNeedsMoving([{
            yamlPath: '/app/storage/sidecar/foo.yml',
            mediaPaths: ['/app/originals/foo.png']
        }])

        expect(organised.length).toBe(1)
        expect(organised[0].currentPath).toBe('/app/originals/foo.png')
        expect(organised[0].targetPath).toBe('/app/originals/2016/01/foo.png')
    })

    test('should reorganise stacks', async() => {
        vol.fromJSON({
            './originals/foo.png': '',
            './originals/foo.jpg': '',
            './storage/sidecar/foo.yml': `TakenAt: 2016-01-01T12:00:00Z
Private: false
Archived: false`,
        }, '/app');

        const organised = await findMediaThatNeedsMoving([{
            yamlPath: '/app/storage/sidecar/foo.yml',
            mediaPaths: [
                '/app/originals/foo.png',
                '/app/originals/foo.jpg',
            ]
        }])

        expect(organised.length).toBe(2)
        expect(organised[0].currentPath).toBe('/app/originals/foo.png')
        expect(organised[0].targetPath).toBe('/app/originals/2016/01/foo.png')
        expect(organised[1].currentPath).toBe('/app/originals/foo.jpg')
        expect(organised[1].targetPath).toBe('/app/originals/2016/01/foo.jpg')
    })

    test('should not reorganise if path already correct', async() => {
        vol.fromJSON({
            './originals/2016/01/foo.png': '',
            './storage/sidecar/foo.yml': `TakenAt: 2016-01-01T12:00:00Z
Private: false`,
        }, '/app');

        const organised = await findMediaThatNeedsMoving([{
            yamlPath: '/app/storage/sidecar/foo.yml',
            mediaPaths: ['/app/originals/2016/01/foo.png']
        }])

        expect(organised.length).toBe(0)
    })

    test('should not reorganise if private', async() => {
        vol.fromJSON({
            './originals/private/foo.png': '',
            './storage/sidecar/foo.yml': `TakenAt: 2016-01-01T12:00:00Z
Private: true`,
        }, '/app');

        const organised = await findMediaThatNeedsMoving([{
            yamlPath: '/app/storage/sidecar/foo.yml',
            mediaPaths: ['/app/originals/private/foo.png']
        }])

        expect(organised.length).toBe(0)
    })

    test('should not reorganise if archived', async() => {
        vol.fromJSON({
            './originals/private/foo.png': '',
            './storage/sidecar/foo.yml': `TakenAt: 2016-01-01T12:00:00Z
Private: false
DeletedAt: 2020-01-01T12:00:00Z`,
        }, '/app');

        const organised = await findMediaThatNeedsMoving([{
            yamlPath: '/app/storage/sidecar/foo.yml',
            mediaPaths: ['/app/originals/private/foo.png']
        }])

        expect(organised.length).toBe(0)
    })
})

describe(renameMediaFilesWithPrompt, () => {
    const envBackup = env

    beforeEach(() => {
        jest.resetModules()
        vol.reset()
        env.ORIGINALS_PATH = '/app/originals/'
        env.SIDECAR_PATH = '/app/storage/sidecar/'
    })

    afterEach(() => {
        env = envBackup
    })

    test('should rename', async() => {
        vol.fromJSON({
            './originals/foo.png': '1', // Needs file contest so the crc32c hash isn't just 0.
            './storage/sidecar/foo.yml': `TakenAt: 2016-01-01T12:00:00Z`,
        }, '/app');

        await renameMediaFilesWithPrompt(
            ['/app/storage/sidecar/foo.yml'],
            false
        )

        // Old name shouldn't be there.
        await expect(vol.promises.access('/app/originals/foo.png')).rejects.toThrow()
        // Should be renamed to.
        await expect(vol.promises.access('/app/originals/20160101_120000_90F599E3.png')).resolves.not.toThrow()
    })

    test('should rename stack of different file types to have the same name', async() => {
        vol.fromJSON({
            './originals/foo.png': '1', // Needs file contest so the crc32c hash isn't just 0.
            './originals/foo.jpg': '2', // Should be different to ensure correct image is being used for hash.
            './storage/sidecar/foo.yml': `TakenAt: 2016-01-01T12:00:00Z`,
        }, '/app');

        await renameMediaFilesWithPrompt(
            ['/app/storage/sidecar/foo.yml'],
            false
        )

        // Old name shouldn't be there.
        await expect(vol.promises.access('/app/originals/foo.png')).rejects.toThrow()
        await expect(vol.promises.access('/app/originals/foo.jpg')).rejects.toThrow()
        // Should be renamed to.
        await expect(vol.promises.access('/app/originals/20160101_120000_90F599E3.png')).resolves.not.toThrow()
        await expect(vol.promises.access('/app/originals/20160101_120000_90F599E3.jpg')).resolves.not.toThrow()
    })

    test('should rename burst stack to have the same name', async() => {
        vol.fromJSON({
            './originals/foo.1.png': '1', // Needs file contest so the crc32c hash isn't just 0.
            './originals/foo.2.png': '2',
            './storage/sidecar/foo.yml': `TakenAt: 2016-01-01T12:00:00Z`,
        }, '/app');

        await renameMediaFilesWithPrompt(
            ['/app/storage/sidecar/foo.yml'],
            false
        )

        // Old name shouldn't be there.
        await expect(vol.promises.access('/app/originals/foo.1.png')).rejects.toThrow()
        await expect(vol.promises.access('/app/originals/foo.2.png')).rejects.toThrow()
        // Should be renamed to.
        await expect(vol.promises.access('/app/originals/20160101_120000_90F599E3.1.png')).resolves.not.toThrow()
        await expect(vol.promises.access('/app/originals/20160101_120000_90F599E3.2.png')).resolves.not.toThrow()
    })

    test('shouldnt rename similar image stack to have the same name', async() => {
        vol.fromJSON({
            './originals/20160101_120000_90F599E3.png': '1',
            './originals/20160101_120000_83A56A17.png': '2',
            './storage/sidecar/20160101_120000_90F599E3.yml': `TakenAt: 2016-01-01T12:00:00Z`,
        }, '/app');

        await renameMediaFilesWithPrompt(
            ['/app/storage/sidecar/20160101_120000_90F599E3.yml'],
            false
        )

        await expect(vol.promises.access('/app/originals/20160101_120000_90F599E3.png')).resolves.not.toThrow()
        await expect(vol.promises.access('/app/originals/20160101_120000_83A56A17.png')).resolves.not.toThrow()
    })

    // /media/harvey/data/Images/Life/main/2022/06/20220610_113909_9C4AC449.jpg and /media/harvey/data/Images/Life/main/2022/06/20220610_113909_B30D5D24.jpg both have one yaml of /media/harvey/data/Images/PhotoPrism/storage/sidecar/2022/06/20220610_113909_B30D5D24.yml

    // BUG: it's not possible to guess the primary image since the user can select a primary?
})
