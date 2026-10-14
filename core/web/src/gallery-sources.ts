import { api, type GalleryPicture, type GalleryVideo, type PictureJob, type VideoJob } from "./api";
import { appendPage as appendPictures, madeButNotListed as picturesMadeButNotListed, mergeTop as mergePictures, tiles as pictureTiles, type Filter as PictureFilter, type Tile as PictureTile } from "./images-gallery";
import { appendPage as appendVideos, madeButNotListed as videosMadeButNotListed, mergeTop as mergeVideos, tiles as videoTiles, type Filter as VideoFilter, type Tile as VideoTile } from "./videos-gallery";
import type { FeedSource } from "./use-gallery-feed";

/**
 * How the Media page's two feeds (use-gallery-feed.ts) ask the portal for their pictures and videos. A page of the gallery
 * is as many as fill a screen and some, and few enough to be quick: a video is much heavier than a picture.
 */

export const pictureSource: FeedSource<GalleryPicture, PictureJob, PictureFilter, PictureTile> = {
  pageSize: 48,
  jobsEvery: 1500,
  page: async (query) => {
    const page = await api.galleryPage(query);
    return { items: page.pictures, next: page.next, total: page.total, pageBytes: page.pageBytes };
  },
  byIds: async (ids) => (await api.galleryPictures(ids)).pictures,
  jobs: () => api.pictureJobs(),
  stopJob: (id) => api.stopPictureJob(id),
  mergeTop: (loaded, fresh) => mergePictures(loaded, { pictures: fresh.items, next: fresh.next }),
  appendPage: appendPictures,
  tiles: pictureTiles,
  lost: picturesMadeButNotListed,
  notes: (job) => job.notes,
  // What was made of a deleted picture does not name it any more, as the portal says it either.
  unlink: (picture, deleted) => (picture.from && deleted.has(picture.from) ? { ...picture, from: null } : picture),
};

export const videoSource: FeedSource<GalleryVideo, VideoJob, VideoFilter, VideoTile> = {
  pageSize: 24,
  jobsEvery: 2000,
  page: async (query) => {
    const page = await api.videoPage(query);
    return { items: page.videos, next: page.next, total: page.total, pageBytes: page.pageBytes };
  },
  byIds: async (ids) => (await api.galleryVideos(ids)).videos,
  jobs: () => api.videoJobs(),
  stopJob: (id) => api.stopVideoJob(id),
  mergeTop: (loaded, fresh) => mergeVideos(loaded, { videos: fresh.items, next: fresh.next }),
  appendPage: appendVideos,
  tiles: videoTiles,
  lost: videosMadeButNotListed,
};
